// h9_tsrp_hive: Paradise City, Alexandria and Xenon City as one .bsp.
//
// THE ENGINE'S BOX. A GoldSrc map lives within 4096 units of the origin on every axis, and each of these
// three cities is a city: Paradise 7224 x 7779 x 1899, Alexandria 7624 x 8076 x 4936, Xenon 4737 x 5531 x
// 3629. None of them leaves room beside another, so they are STACKED, each on its own shelf of rock:
//
//     Xenon City       z  411 .. 4040      (shift +955)
//     Paradise City    z -1488 .. 411      (shift +2077)
//     Alexandria       z -4040 .. -1488    (shift -2440, its dead slab cut off at z=-1600)
//
// Alexandria is a city on a 2.4km-thick slab of solid rock; only its top 40 units are floor. Cutting the
// slab at z=-1600 (a plane added to every brush that crosses it) takes 2432 units of dead rock off the
// bottom and leaves everything a player can reach. What is cut away is a sealed spawn bunker under the
// city (34 point entities, no brush entities) and its rock; the cut faces are NULL, invisible, and solid.
//
// With --no-cut the cities keep their slabs and the stack is 10592 units tall instead, for the raised-limit
// compiler:  alexandria -5296..-336, paradise 48..1947, xenon 2011..5640.
//
// THE WIRE. The three cities cannot touch, so they are joined by teleports: three two-way links, one between
// each pair of cities, each end a travel zone on the floor with its arrival point a few steps ahead of it, so a
// city has one zone to each of the other two (WARP_LINKS). A name is prefixed per city (pc_, al_, xe_) first,
// including multi_manager's names-as-keys, so nothing in one city fires something in another.
//
//   node merge.mjs            write out/h9_tsrp_hive.map, run checkPlan, report
//   node merge.mjs --compile  ... and compile a draft .bsp (fast vis/rad)
//   node merge.mjs --full     ... and compile the finished .bsp (full vis/rad)
//   node merge.mjs --bsp      ... and compile geometry only (hlcsg + hlbsp)
//   node merge.mjs --no-cut   keep Alexandria's slab; the stack no longer fits +/-4096
//   --compilers <folder>      use hlcsg/hlbsp/hlvis/hlrad from that folder instead of ../compilers
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { COMPILERS, M } from "../lib.mjs";
import { CITIES, readCity } from "./probe.mjs";
import { WADS, missingFor, texturesOf } from "./wads.mjs";
import { floorBelow, footing } from "./spots.mjs";
import { portalSprite } from "./portals.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
export const OUT = join(HERE, "out");
export const NAME = "h9_tsrp_hive";

// checkPlan measures the world with Math.min(...every corner). On 18228 brushes that spread needs more stack
// than node's default, so run this file once more with a bigger one rather than skip the check.
if (process.argv[1] === SELF && !process.execArgv.some((arg) => arg.startsWith("--stack-size"))) {
  const again = spawnSync(process.execPath, ["--stack-size=16384", ...process.execArgv, SELF, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(again.status ?? 1);
}

/*
 * THE STACK. z values are the cities' own; `shift` is what is added to every brush plane and entity origin.
 * Alexandria's `cut` is in its own coordinates.
 *
 *   cut (default)   the dead slab under Alexandria is cut off at z=-1600, so the three whole cities fit the
 *                   engine's own +/-4096 box and the map runs anywhere. What is lost is 2.4km of solid rock
 *                   and the sealed spawn bunker buried in it -- no street, no room a player walks.
 *   --no-cut        every city whole, stacked with a 64-unit gap between shelves. 10592 units tall, so it
 *                   needs the raised/large-coordinate compiler and an engine that sends big coordinates.
 */
export const LAYOUTS = {
  cut: {
    alexandria: { key: "al", shift: [0, 0, -2440], cut: -1600 },
    paradise: { key: "pc", shift: [0, 0, 2077] },
    xenon: { key: "xe", shift: [0, 0, 955] },
  },
  whole: {
    alexandria: { key: "al", shift: [0, 0, -1312] },
    paradise: { key: "pc", shift: [0, 0, 3269] },
    xenon: { key: "xe", shift: [0, 0, 2211] },
  },
};
export const NO_CUT = process.argv.includes("--no-cut");
export const LAYOUT = NO_CUT ? LAYOUTS.whole : LAYOUTS.cut;

/*
 * THE LINKS. Each pair of cities is joined both ways, and each end is a travel zone: walking into it sends you
 * to the other end, where you arrive ARRIVE_AHEAD units in front of that end's own zone, facing its yaw --
 * away from the zone, so arriving never sends you straight back. Merged coordinates; z is the floor. warps()
 * proves every zone and arrival against the city's space model (floor, headroom, dry, no brush entity in the
 * way, a clear line between them) and stops the build on any that fails.
 */
export const WARP_LINKS = [
  [{ key: "pc", at: [1653, 2676, -564], yaw: 28 }, { key: "al", at: [-922, -3187, -2360], yaw: 90 }],
  // the zone sits 8 units north of the spot it was picked at, so its 48-unit footprint clears the wall at y -1058
  [{ key: "pc", at: [-54, -1033, -1036], yaw: 91 }, { key: "xe", at: [-2812, -98, 554], yaw: 1 }],
  [{ key: "xe", at: [506, -1093, 979], yaw: 180 }, { key: "al", at: [-765, 1526, -2824], yaw: 91 }],
];
const ARRIVE_AHEAD = 80;

const SKY = "blue";
const TRIGGER = [48, 48, 64];

/*
 * WHAT MARKS A TRAVEL ZONE. Nothing solid is built: a zone is its trigger and, over it, an animated portal in
 * the colour of the city it leads to (portals.mjs makes them; they ship in ts\sprites). An env_sprite that
 * carries a name starts switched off unless spawnflag 1 is set, so it is.
 */
const PORTAL_HEIGHT = 40; // the sprite's centre over the floor
const PORTAL_SCALE = 1.25; // 64 pixels at 1.25: 80 units across
const PORTAL_FRAMERATE = 12; // 24 frames: one loop every two seconds

/*
 * THE LIGHT-STYLE CEILING. hlcsg gives every name a switched light carries a style of its own, and the engine
 * has 32 to spare (32..63). The three cities bring 40 between them. These seven are television glows in
 * Paradise, each on its own set-top button: leaving them always lit costs a flicker and buys the styles the
 * rest of the map needs. Every other switched light keeps its switch. Any light nothing fires loses its name
 * too -- it was never switched in the first place.
 */
const UNSWITCHED_LIGHTS = new Set(["pc_tvset1", "pc_tvset2", "pc_tvset3", "pc_tvset4", "pc_tvsetgear", "pc_tvsetcit2", "pc_tvsetcit6"]);

const AXES = ["x", "y", "z"];
const TEXTURE_SUBSTITUTE = { MARB052: "CDS_TILEFWHITE", PO_HTLCARPET: "GREENCARPET" };
/**
 * Fence/mesh/grate textures found wrapped in func_illusionary (non-solid) in Alexandria's and
 * Xenon's decompiled sources, confirmed by direct brush/face audit against the merged map --
 * see the func_illusionary -> func_wall reclassification in city(). Matched case-insensitively
 * against each face's own texture name.
 */
const FENCE_TEXTURES = new Set([
  "{PKF_FENCE1",
  "{PKF_FENCE2A",
  "{PKF_FENCE2C",
  "{TENSION4",
  "{METALCROSS1DN",
  "{CA_GIRDER",
  "{PKF_SHOPGRATE1",
  "{PV_ASLGRATE",
]);
/** Keys whose value names entities. */
const LINK_KEYS = ["target", "master", "killtarget", "LaserTarget"];
/** Classes whose `message` names what a train fires as it passes them, where every other class's is words. */
const PASS_TARGET_CLASSES = new Set(["path_corner", "path_track"]);
const linkKeysOf = (entity) => (PASS_TARGET_CLASSES.has(entity.classname) ? [...LINK_KEYS, "message"] : LINK_KEYS);
/** Classes that exist only as geometry: without brushes they are nothing, whatever name they carry. */
const BRUSH_ONLY = /^(func_|trigger_(push|teleport|multiple|once|hurt|gravity|waterydeath)$)/;

const round = (v) => Math.round(v * 1000) / 1000;
const numbersOf = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).map(Number);

// ---------------------------------------------------------------------------------------------------------
// one city's geometry

/** A brush's true box, from its planes: what the brushes actually reach. */
function boundsOf(shape) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const face of shape.faces)
    for (const point of face.polygon)
      for (let a = 0; a < 3; a++) {
        if (point[a] < min[a]) min[a] = point[a];
        if (point[a] > max[a]) max[a] = point[a];
      }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

function boxOf(brush) {
  return boundsOf(M.shapeOf(brush));
}

/**
 * A brush cut flat at `z`: the part above kept. A Valve 220 brush is its planes, so cutting is one more
 * plane -- no geometry has to be rebuilt, and the compiler cuts the polygons itself. The new face's three
 * points sit on the plane by the brush, wound so the normal points down (out of the kept solid), and it wears
 * NULL so the cut is not drawn. Faces the plane removes whole go with the part they bounded; keeping them
 * would leave the brush with zero-area sides. Returns null for a brush wholly under the plane.
 */
function cutBrush(brush, z) {
  const shape = M.shapeOf(brush);
  const box = boundsOf(shape);
  if (!box) return brush;
  if (box.max[2] <= z + 0.01) return null;
  if (box.min[2] >= z - 0.01) return brush;
  const cx = round((box.min[0] + box.max[0]) / 2);
  const cy = round((box.min[1] + box.max[1]) / 2);
  const { u, v } = M.textureAxes([0, 0, -1]);
  // a liquid brush's cap must be liquid too, or hlcsg reads two contents in one brush
  const liquid = brush.faces.find((face) => isLiquid(face.texture));
  const face = {
    // planeOf: cross(p0 - p1, p2 - p1) = (0, 0, -1), the outward side of the kept solid
    points: [[cx + 64, cy, z], [cx, cy, z], [cx, cy - 64, z]],
    texture: liquid ? liquid.texture : "NULL",
    u: [...u, 0],
    v: [...v, 0],
    rotation: 0,
    scale: [1, 1],
  };
  const faces = brush.faces.filter((_, index) => (shape.faces[index]?.polygon ?? []).some((point) => point[2] > z + 0.01));
  return { faces: [...faces, face] };
}

/**
 * The decompiler wrote every face's three plane points a million units out. A plane is the same wherever its
 * points sit, but hlcsg takes a brush's bounds from them, and brushes whose planes are nearly parallel then
 * come out reaching +/-80000 and stop the compile. Re-point each face within a few units of its brush: same
 * plane, same winding, same texture axes, sane bounds.
 */
const TIGHT = 32;
function tightenPlanes(brush, shape) {
  const center = shape.min.map((value, a) => (value + shape.max[a]) / 2);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (vector) => {
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    return length ? vector.map((value) => value / length) : [0, 0, 1];
  };
  const faces = brush.faces.map((face, index) => {
    const normal = shape.faces[index]?.normal;
    if (!normal || face.exact) return face; // an exact face's whole-number points are the point of it
    const offset = dot(normal, center) - dot(normal, face.points[0]);
    const base = center.map((value, a) => round(value - normal[a] * offset));
    const along = unit(cross(normal, Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const across = cross(normal, along);
    const point = (vector) => base.map((value, a) => round(value + vector[a] * TIGHT));
    // cross(point0 - point1, point2 - point1) = cross(-across, along) * TIGHT^2 = normal
    return { ...face, points: [base, point(across), point(along)] };
  });
  return { ...brush, faces };
}

/** Every targetname a city uses, matched without regard to case. */
function namesOf(map) {
  const names = new Map();
  for (const entity of map.entities ?? []) if (entity.targetname) names.set(String(entity.targetname).toLowerCase(), entity.targetname);
  return names;
}

/** One name, prefixed: `cube.1.destination` -> `al_cube.1.destination`. */
const prefixed = (prefix, name) => `${prefix}_${name}`;

/**
 * A city's entities with every name link inside it made local.
 *
 * multi_manager is why this is not just a rename of `targetname` and `target`: it stores the entities it
 * fires as KEYS (`"MDELEVATOR" "1"`), with the delay as the value. A renamed elevator that keeps the old
 * key silently loses its manager, and nothing errors -- it just does not move. A name it fires more than
 * once is written `MDELEVATOR#1`, `MDELEVATOR#2`: the game reads the key up to the `#`, so the name before
 * it is prefixed and the `#` part kept. A path_corner's `message` is a name too: what it fires as a train
 * passes.
 */
function prefixedEntities(entities, names, prefix) {
  return (entities ?? []).map((entity) => {
    const out = { ...entity };
    if (out.targetname) out.targetname = prefixed(prefix, out.targetname);
    for (const key of linkKeysOf(out)) {
      if (out[key] === undefined) continue;
      out[key] = String(out[key])
        .split(/([\s;,]+)/)
        .map((part) => {
          if (!part || /^[\s;,]+$/.test(part)) return part;
          const original = names.get(part.toLowerCase());
          return original ? prefixed(prefix, original) : part;
        })
        .join("");
    }
    if (out.classname === "multi_manager") {
      for (const [key, value] of Object.entries(out)) {
        if (["classname", "targetname", "origin", "angles", "spawnflags", "style", "delay", "wait", "message"].includes(key)) continue;
        const [name, ...copy] = key.split("#");
        const original = names.get(name.toLowerCase());
        if (!original) continue;
        delete out[key];
        out[[prefixed(prefix, original), ...copy].join("#")] = value;
      }
    }
    return out;
  });
}

/** A liquid face: water (`!`) or lava (`*`), the two contents that cannot share a brush with solid. */
const isLiquid = (texture) => /^[!*]/.test(texture);

/**
 * A brush holds one content. Alexandria's decompile left eight brushes with a single `!seawater` face among
 * solid or sky ones -- noise, since a water body is a whole brush, not one side of it. The odd face takes the
 * texture of a solid face beside it, so hlcsg no longer reads "mixed face contents".
 */
function settleContents(brushes) {
  let fixed = 0;
  for (const brush of brushes) {
    const liquid = brush.faces.filter((face) => isLiquid(face.texture));
    if (!liquid.length || liquid.length === brush.faces.length) continue;
    const solid = brush.faces.find((face) => !isLiquid(face.texture));
    if (!solid) continue;
    for (const face of liquid) face.texture = solid.texture;
    fixed++;
  }
  return fixed;
}

/** A face's plane as its outward normal and distance: n . x = d. */
function planeOf(face) {
  const [p0, p1, p2] = face.points;
  const a = [p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]];
  const c = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const n = [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
  const length = Math.hypot(n[0], n[1], n[2]) || 1;
  const unit = n.map((value) => value / length);
  return { n: unit, d: unit[0] * p0[0] + unit[1] * p0[1] + unit[2] * p0[2] };
}

/**
 * The decompile sometimes splits one wall into faces whose planes differ by a hundredth of a unit; hlcsg stops
 * with "has a coplanar plane". Two planes this close describe one surface, so the later face goes.
 */
function dedupePlanes(brush) {
  const kept = [];
  const faces = [];
  for (const face of brush.faces) {
    const plane = planeOf(face);
    const twin = kept.some((other) => {
      const dot = plane.n[0] * other.n[0] + plane.n[1] * other.n[1] + plane.n[2] * other.n[2];
      if (Math.abs(dot) < 0.9999) return false;
      return Math.abs(plane.d - (dot < 0 ? -other.d : other.d)) < 0.5;
    });
    if (twin) continue;
    kept.push(plane);
    faces.push(face);
  }
  const removed = brush.faces.length - faces.length;
  return removed ? { brush: { ...brush, faces }, removed } : { brush, removed: 0 };
}

/** A brush thinner than half a unit on any axis: the decompile's leftovers, which hlcsg cannot bound. */
const sliver = (shape) => Math.min(shape.max[0] - shape.min[0], shape.max[1] - shape.min[1], shape.max[2] - shape.min[2]) < 0.5;

/** A brush whose planes do not close: its polygons run out to the decompiler's million-unit plane points. */
const unbound = (shape) => [...shape.min, ...shape.max].some((value) => Math.abs(value) > 8192);


/**
 * A hollow box of NULL brushes just inside a city's bounds: the decompile's gaps cannot reach the void. Thin,
 * because hlcsg lets the later brush win: any face of the city's own that the shell overlaps is cut away and
 * the NULL face in its place is never drawn, so a wall within the shell's thickness of the city's edge would
 * be see-through. buriedFaces() proves none is.
 */
const SHELL = 4;
function sealBox(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const t = SHELL;
  return [
    M.box([x0, y0, z0], [x0 + t, y1, z1], "NULL"),
    M.box([x1 - t, y0, z0], [x1, y1, z1], "NULL"),
    M.box([x0 + t, y0, z0], [x1 - t, y0 + t, z1], "NULL"),
    M.box([x0 + t, y1 - t, z0], [x1 - t, y1, z1], "NULL"),
    M.box([x0 + t, y0 + t, z0], [x1 - t, y1 - t, z0 + t], "NULL"),
    M.box([x0 + t, y0 + t, z1 - t], [x1 - t, y1 - t, z1], "NULL"),
  ];
}

/**
 * The drawn faces of a city's own brushes that the seal shell would bury: a corner deep inside one of its six
 * slabs, or the whole face on a slab's inner plane facing into the city (coplanar, the shell's NULL face would
 * win). The shell's outer face is the city's bound rounded outward, so the city's own edge sits up to a unit
 * into the slab; that unit, and faces turned to the void, are no loss. A city cut off at `cut` has its bottom
 * slab on the cut plane, inside the rock under its floors, where what it buries was never seen.
 */
function buriedFaces(brushes, min, max, { cut = false } = {}) {
  const EPS = 0.01;
  const EDGE = 1;
  const found = [];
  for (const brush of brushes) {
    const shape = M.shapeOf(brush);
    brush.faces.forEach((face, index) => {
      if (/^NULL$/i.test(face.texture)) return;
      const polygon = shape.faces[index]?.polygon ?? [];
      const normal = shape.faces[index]?.normal;
      if (!polygon.length || !normal) return;
      for (let a = 0; a < 3; a++) {
        for (const side of [-1, 1]) {
          if (normal[a] * side > 0.5) continue;
          if (cut && a === 2 && side < 0) continue;
          const depth = (p) => (side < 0 ? p[a] - min[a] : max[a] - p[a]);
          const deep = polygon.some((p) => depth(p) > EDGE + EPS && depth(p) < SHELL - EPS);
          const onInner = polygon.every((p) => Math.abs(depth(p) - SHELL) <= EPS) && normal[a] * -side > 0.5;
          if (deep || onInner) {
            found.push({ texture: face.texture, at: polygon[0].map((v) => Math.round(v)) });
            return;
          }
        }
      }
    });
  }
  return found;
}

/** Every brush's box, together. */
function cityBox(brushes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const brush of brushes) {
    const box = boxOf(brush);
    if (!box) continue;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], box.min[a]);
      max[a] = Math.max(max[a], box.max[a]);
    }
  }
  return { min, max };
}

/** The pictures that need a substitute, everywhere they appear. */
function substituteTextures(brushes) {
  for (const brush of brushes) for (const face of brush.faces) if (TEXTURE_SUBSTITUTE[face.texture]) face.texture = TEXTURE_SUBSTITUTE[face.texture];
  return brushes;
}

/** Every name any entity fires, so a light can tell whether its switch still exists. */
function firedNames(entities) {
  const names = new Set();
  for (const entity of entities) {
    for (const key of linkKeysOf(entity)) {
      if (entity[key] === undefined) continue;
      for (const part of String(entity[key]).split(/[\s;,]+/)) if (part) names.add(part);
    }
    if (entity.classname === "multi_manager") for (const key of Object.keys(entity)) names.add(key.split("#")[0]);
  }
  return names;
}

/** Takes the name off the lights that stay lit (UNSWITCHED_LIGHTS, and lamps nothing fires). */
function unswitchLights(entities) {
  const fired = firedNames(entities);
  const stripped = [];
  for (const entity of entities) {
    if (!/^light/.test(entity.classname ?? "") || !entity.targetname) continue;
    const name = String(entity.targetname);
    if (fired.has(name) && !UNSWITCHED_LIGHTS.has(name)) continue;
    delete entity.targetname;
    stripped.push(name);
  }
  return stripped;
}

/**
 * Alexandria's own decompile (b4v3) left its 3 tube "jump assist" trigger_push entities with no brush
 * geometry at all -- confirmed orphaned in the raw source itself (classname/speed/angles only, no brushes,
 * no origin), not something this merge drops. A newer decompile of the same map (alexandria_msr_b5.bsp,
 * confirmed by the user to be the latest) recovered real geometry for the same 3 triggers, matched here by
 * their (speed, angles) pair since that is all the orphans carry. Two independent landmarks confirmed b4v3
 * and b5 share the exact same coordinate frame with zero offset (main.elev.2.sound's origin and
 * spawn.core.1's func_train brush planes, both byte-identical between the two files), so b5's brushes are
 * grafted in verbatim, with no transform, and then flow through the same shift/cut pipeline as every other
 * brush entity in the city. b5 also recovered a 4th trigger_push (targetname spawn.push), but its geometry
 * sits entirely below Alexandria's z=-1600 cut -- inside the sealed bunker this layout already removes --
 * so it is left out: grafting it would be dead geometry in the shipped map.
 */
const ALEXANDRIA_PUSH_SOURCE = "alexandria_msr_b5.map";
const ALEXANDRIA_PUSH_WANTED = [
  { speed: "800", angles: "0 180 0" },
  { speed: "800", angles: "-90 0 0" },
  { speed: "400", angles: "0 90 0" },
];
function alexandriaPushFix(map) {
  const source = readCity(ALEXANDRIA_PUSH_SOURCE).map.entities ?? [];
  let fixed = 0;
  map.entities = (map.entities ?? []).map((entity) => {
    if (entity.classname !== "trigger_push" || entity.brushes?.length) return entity;
    const wanted = ALEXANDRIA_PUSH_WANTED.find((w) => w.speed === String(entity.speed) && w.angles === String(entity.angles));
    if (!wanted) return entity;
    const match = source.find((candidate) => candidate.classname === "trigger_push" && candidate.brushes?.length && String(candidate.speed) === wanted.speed && String(candidate.angles) === wanted.angles);
    if (!match) return entity;
    fixed++;
    return { ...entity, brushes: match.brushes };
  });
  return fixed;
}

/*
 * SEE-THROUGH WALLS THE DECOMPILE LEFT IN XENON. Two lean planes on a facade are written a few hundredths off
 * the grid the original compile used (xenoncity_final.bsp has them on it); where they meet the wall's trim,
 * the space in front of the wall compiles as faceless solid -- a hole to the void. Every face on each plane,
 * in every brush of the city and on both sides of it so neighbours stay flush, is rewritten onto the exact
 * plane through two (x, z) points, parallel to y, with whole-number points. Elsewhere two slivers 0.2-0.6
 * units thick at the foot of a wall leave a faceless band; they are dropped, the wall running on behind them.
 * Each target is checked against what it was when this was written, so a changed source stops the build.
 */
const XENON_LEAN_PLANES = [
  { label: "upper lean", n: [-0.9778, 0, 0.20953], d: -148.619, through: [[434, 1316], [464, 1456]], faces: 15 },
  { label: "lower lean", n: [-0.95549, 0, -0.29501], d: -802.972, through: [[434, 1316], [455, 1248]], faces: 12 },
];
const XENON_SLIVERS = [
  { brush: 3214, box: [[121, -728.35, 1316], [810, -717.04, 1366.86]], textures: { cyberwall1: 5 } },
  { brush: 3215, box: [[121, -738.25, 1316], [810, -717.64, 1413.91]], textures: { cyberwall1: 5 } },
];
const XENON_SLIVER_BACKING = { brushes: [1661, 3728, 1463], texture: "cyberwall1", n: [0, 0.97898, 0.20395], d: -434.361 };

const dotOf = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** +1 when a face lies on the plane, -1 when it lies on it facing the other way, 0 when it does not. */
function sideOn(face, plane, tolerance = 0.2) {
  const own = planeOf(face);
  const dot = dotOf(own.n, plane.n);
  if (Math.abs(dot) < 0.9999) return 0;
  return Math.abs(own.d - (dot < 0 ? -plane.d : plane.d)) < tolerance ? Math.sign(dot) : 0;
}

function snapLeanPlane(map, plane) {
  const sets = [map.brushes ?? [], ...(map.entities ?? []).filter((entity) => entity.brushes).map((entity) => entity.brushes)];
  const [[x0, z0], [x1, z1]] = plane.through;
  let count = 0;
  for (const brushes of sets) {
    for (const brush of brushes) {
      const shape = M.shapeOf(brush);
      for (const face of brush.faces) {
        if (!sideOn(face, plane)) continue;
        const own = planeOf(face).n;
        const y0 = Math.floor(shape.min[1]);
        const y1 = Math.max(y0 + 1, Math.ceil(shape.max[1]));
        let points = [[x0, y0, z0], [x1, y0, z1], [x0, y1, z0]];
        if (dotOf(planeOf({ points }).n, own) < 0) points = [points[0], points[2], points[1]];
        const turn = dotOf(planeOf({ points }).n, own);
        if (turn < 0.9999) throw new Error(`xenon ${plane.label}: the exact plane turns ${((Math.acos(Math.min(1, turn)) * 180) / Math.PI).toFixed(3)} degrees from a face on it`);
        face.points = points;
        face.exact = true;
        count++;
      }
    }
  }
  if (count !== plane.faces) throw new Error(`xenon ${plane.label}: ${count} faces lie on it, not ${plane.faces} -- the source changed`);
  return count;
}

function repairXenon(map) {
  for (const { brush: index, box: want, textures } of XENON_SLIVERS) {
    const label = `xenon world brush #${index}`;
    const box = boxOf(map.brushes[index] ?? { faces: [] });
    if (!box || want.some((corner, c) => corner.some((v, a) => Math.abs(v - (c ? box.max : box.min)[a]) > 0.05)))
      throw new Error(`${label}: its box is ${box ? `${box.min.map(round)} .. ${box.max.map(round)}` : "empty"}, not ${want[0]} .. ${want[1]} -- the source changed`);
    const counts = {};
    for (const face of map.brushes[index].faces) counts[face.texture.toLowerCase()] = (counts[face.texture.toLowerCase()] ?? 0) + 1;
    if (JSON.stringify(counts) !== JSON.stringify(textures)) throw new Error(`${label}: textures ${JSON.stringify(counts)}, not ${JSON.stringify(textures)}`);
  }
  for (const index of XENON_SLIVER_BACKING.brushes) {
    const brush = map.brushes[index];
    const ok = brush?.faces.some((face) => face.texture.toLowerCase() === XENON_SLIVER_BACKING.texture && sideOn(face, XENON_SLIVER_BACKING, 0.05) !== 0);
    if (!ok) throw new Error(`xenon world brush #${index} no longer carries the ${XENON_SLIVER_BACKING.texture} wall the slivers stand in front of`);
  }
  const snapped = XENON_LEAN_PLANES.reduce((sum, plane) => sum + snapLeanPlane(map, plane), 0);
  const drop = new Set(XENON_SLIVERS.map((sliver) => sliver.brush));
  map.brushes = map.brushes.filter((_, index) => !drop.has(index));
  return { snapped, dropped: drop.size };
}

/**
 * Alexandria's lab gate (midgar.lab.gate.one, two func_doors) has one opener: the console panel beside it,
 * labentbutton, a func_door that moves nowhere (its lip is its whole width) and fires the gate each time it
 * toggles. The source gives the panel a name and no Use flag, so neither a touch (a named door ignores
 * touches) nor the use key works it, and the gate never opens. The Use flag (256) is added to its toggle (32).
 */
const USABLE_PANELS = { alexandria: [{ targetname: "labentbutton", classname: "func_door", spawnflags: "32" }] };
const DOOR_USE_ONLY = 256;

/**
 * One city, ready to stack: its brushes cut and moved, its entity names local, its origins moved, and
 * anything that lived entirely below its cut plane gone.
 */
function city(cityName) {
  const layout = LAYOUT[cityName];
  const read = readCity(CITIES[cityName]);
  const map = read.map;
  const repaired = cityName === "xenon" ? repairXenon(map) : { snapped: 0, dropped: 0 };
  const pushFixed = cityName === "alexandria" ? alexandriaPushFix(map) : 0;
  const { shift, cut, key: prefix } = layout;

  let pruned = 0;
  let deduped = 0;
  const prepare = (raw) => {
    const { brush, removed } = dedupePlanes(raw);
    deduped += removed;
    const shape = M.shapeOf(brush);
    // a decompiler leftover whose planes enclose nothing, or a sliver no compiler can bound, or one still open
    if (!shape.corners.length || sliver(shape) || unbound(shape)) {
      pruned++;
      return null;
    }
    const kept = cut === undefined ? brush : cutBrush(brush, cut);
    if (!kept) return null;
    const keptShape = kept === brush ? shape : M.shapeOf(kept);
    if (sliver(keptShape) || unbound(keptShape)) {
      pruned++;
      return null;
    }
    return M.moved(tightenPlanes(kept, keptShape), shift);
  };
  let settled = settleContents(map.brushes ?? []);
  for (const entity of map.entities ?? []) if (entity.brushes) settled += settleContents(entity.brushes);
  const brushes = substituteTextures((map.brushes ?? []).map(prepare).filter(Boolean));

  // The decompile left gaps in Alexandria's shell that let the void in; each city gets its own invisible box,
  // just inside its bounds, so a leak cannot escape into the world outside. The pads, arrivals and spawns are
  // all well inside it.
  const bounds = cityBox(brushes);
  const shellMin = bounds.min.map((value) => Math.floor(value));
  const shellMax = bounds.max.map((value) => Math.ceil(value));
  const buried = buriedFaces(brushes, shellMin, shellMax, { cut: cut !== undefined });
  if (buried.length)
    throw new Error(`${cityName}: the ${SHELL}-unit seal shell would bury ${buried.length} drawn faces, e.g. ${buried.slice(0, 5).map((f) => `${f.texture} at ${f.at.join(" ")}`).join("; ")}`);
  const shell = sealBox(shellMin, shellMax);
  brushes.push(...shell);

  const entities = [];
  let droppedBelow = 0;
  let droppedSun = 0;
  let droppedEmpty = 0;
  let droppedWeapons = 0;
  let reclassedFences = 0;
  let usablePanels = 0;
  let strippedOrigins = 0;
  const texlights = [];
  for (const original of map.entities ?? []) {
    // the cities had three suns and one sky; the merged map has one sky and takes one sun (Alexandria's)
    if (original.classname === "light_environment" && cityName !== "alexandria") {
      droppedSun++;
      continue;
    }
    // hlrad reads every info_texlights and the first to name a texture wins; build() writes one for the map
    if (original.classname === "info_texlights") {
      for (const [key, value] of Object.entries(original)) if (typeof value === "string" && key !== "classname") texlights.push([key, value]);
      continue;
    }
    // Map-authored ts_groundweapon pickups are dropped entirely rather than repositioned: the
    // ones in Alexandria's own decompiled source sit 40-88 units above their nearest floor
    // (confirmed identical in the raw, unmerged source -- a pre-existing decompile defect, not
    // a merge artifact), and no other city places any. Weapons dropped live during a match are
    // a separate, unrelated runtime mechanic (task_clean_drops in ts_matchmode.sma) and are
    // untouched by this.
    if (original.classname === "ts_groundweapon") {
      droppedWeapons++;
      continue;
    }
    const entity = { ...original };
    const at = entity.origin === undefined ? [] : numbersOf(entity.origin);
    const placed = at.length === 3 && at.every(Number.isFinite);
    // No place and no geometry, and no name for anything to fire: the engine would dump it at 0 0 0 to no
    // effect. Alexandria's .map carries 29 of these -- empty ladders, pushes, teleports, bubbles.
    if (!entity.brushes?.length && !placed && (!entity.targetname || BRUSH_ONLY.test(entity.classname ?? ""))) {
      droppedEmpty++;
      continue;
    }
    if (placed) {
      if (cut !== undefined && at[2] < cut) {
        droppedBelow++;
        continue;
      }
      entity.origin = at.map((v, a) => round(v + shift[a])).join(" ");
    }
    if (entity.brushes) {
      const cutBrushes = entity.brushes.map(prepare).filter(Boolean);
      if (!cutBrushes.length) {
        droppedBelow++;
        continue;
      }
      entity.brushes = substituteTextures(cutBrushes);
      // an ORIGIN brush already carries the pivot; the matching origin key makes hlcsg see two
      if (entity.brushes.some((brush) => brush.faces.some((face) => face.texture.toUpperCase() === "ORIGIN"))) {
        if (entity.origin !== undefined) strippedOrigins++;
        delete entity.origin;
      }
      // func_illusionary's clip hulls are never used (SOLID_NOT), regardless of texture or
      // rendermode -- confirmed in this kit's own decompiler (NOCLIP_CLASSES). Alexandria and
      // Xenon's decompiled sources wrap several fence/grate meshes in func_illusionary instead
      // of func_wall, so they render correctly (rendermode 4 is already set right) but have no
      // collision at all. Reclassified to func_wall here, the same solid+see-through idiom this
      // project's own code already uses correctly elsewhere (spec/map.mjs's `seeThrough`).
      if (entity.classname === "func_illusionary" && entity.brushes.some((brush) => brush.faces.some((face) => FENCE_TEXTURES.has(face.texture.toUpperCase())))) {
        entity.classname = "func_wall";
        reclassedFences++;
      }
    }
    const panel = (USABLE_PANELS[cityName] ?? []).find((wanted) => wanted.targetname === entity.targetname);
    if (panel) {
      if (entity.classname !== panel.classname || String(entity.spawnflags ?? "0") !== panel.spawnflags)
        throw new Error(`${cityName}: ${panel.targetname} is a ${entity.classname} with spawnflags ${entity.spawnflags ?? 0}, not the ${panel.classname} with ${panel.spawnflags} it is made usable from`);
      entity.spawnflags = String(Number(panel.spawnflags) | DOOR_USE_ONLY);
      usablePanels++;
    }
    entities.push(entity);
  }
  if (usablePanels !== (USABLE_PANELS[cityName] ?? []).length)
    throw new Error(`${cityName}: ${usablePanels} of the ${(USABLE_PANELS[cityName] ?? []).length} panels to make usable were found`);

  const named = prefixedEntities(entities, namesOf(map), prefix);
  return { cityName, file: read.file, prefix, shift, brushes, entities: named, texlights, droppedBelow, droppedSun, droppedEmpty, droppedWeapons, reclassedFences, usablePanels, pushFixed, snapped: repaired.snapped, dropped: repaired.dropped, settled, pruned, deduped, strippedOrigins, shell: shell.length, sealed: { min: shellMin, max: shellMax } };
}

// ---------------------------------------------------------------------------------------------------------
// the travel zones

/** A travel zone: the trigger that sends a body to `target`, and over it the portal of the city it leads to. */
function travelZone(from, to, [x, y, floor], target) {
  const half = [TRIGGER[0] / 2, TRIGGER[1] / 2];
  const trigger = M.box([x - half[0], y - half[1], floor + 1], [x + half[0], y + half[1], floor + 1 + TRIGGER[2]], "AAATRIGGER");
  return [
    M.brushEntity("trigger_teleport", [trigger], {
      targetname: `hive_${from}_pad_${to}`,
      target,
    }),
    M.pointEntity("env_sprite", [x, y, round(floor + PORTAL_HEIGHT)], {
      targetname: `hive_${from}_portal_${to}`,
      model: portalSprite(to),
      scale: String(PORTAL_SCALE),
      rendermode: "5", // additive: a light, not a picture
      renderamt: "255",
      framerate: String(PORTAL_FRAMERATE),
      spawnflags: "1", // start on
    }),
  ];
}

/** A spot a body stands on: the floor where it is said to be, a standing player fitting there, and dry. */
function checkStand(space, [x, y, floor], label) {
  const below = floorBelow(space, x, y, floor + 32, 64);
  if (below === null || Math.abs(below - floor) > 0.5) throw new Error(`${label}: the floor there is ${below ?? "missing"}, not ${floor}`);
  if (!footing(space, x, y, floor, { slack: 1 })) throw new Error(`${label}: a standing player does not fit there (wall, ceiling or water)`);
}

const boxesMeet = (a, b) => [0, 1, 2].every((axis) => a.min[axis] < b.max[axis] && b.min[axis] < a.max[axis]);

/** Builds the WARP_LINKS: at each end a travel zone that sends a body to the far end's arrival, and that end's own arrival point. */
function warps(cities) {
  const cityOf = Object.fromEntries(Object.entries(LAYOUT).map(([name, layout]) => [layout.key, name]));
  const spaces = {};
  const spaceFor = (key) => (spaces[key] ??= M.spaceOf({ brushes: cities[cityOf[key]].brushes, entities: cities[cityOf[key]].entities }));
  const arrivalOf = ({ at: [x, y, floor], yaw }) => {
    const turn = (yaw * Math.PI) / 180;
    return [Math.round(x + Math.cos(turn) * ARRIVE_AHEAD), Math.round(y + Math.sin(turn) * ARRIVE_AHEAD), floor];
  };
  const out = [];
  const report = [];
  for (const [first, second] of WARP_LINKS) {
    for (const [end, far] of [[first, second], [second, first]]) {
      const space = spaceFor(end.key);
      const sealed = cities[cityOf[end.key]].sealed;
      const pad = end.at;
      const arrival = arrivalOf(end);
      const label = `the ${end.key} end of the ${end.key}-${far.key} link`;
      checkStand(space, pad, `${label}, its pad`);
      checkStand(space, arrival, `${label}, its arrival`);
      const zone = M.restOf(space, pad, { half: TRIGGER[0] / 2, height: 72 });
      if (!zone.fits || zone.hang > 1) throw new Error(`${label}: the ${TRIGGER[0]}-unit zone does not fit at ${pad.join(" ")}`);
      const trigger = { min: [pad[0] - TRIGGER[0] / 2, pad[1] - TRIGGER[1] / 2, pad[2] + 1], max: [pad[0] + TRIGGER[0] / 2, pad[1] + TRIGGER[1] / 2, pad[2] + 1 + TRIGGER[2]] };
      const inWay = space.areas.find((area) => boxesMeet(trigger, area));
      if (inWay) throw new Error(`${label}: the pad's trigger meets ${inWay.classname}${inWay.targetname ? ` ${inWay.targetname}` : ""}`);
      if (Math.hypot(arrival[0] - pad[0], arrival[1] - pad[1]) < 64) throw new Error(`${label}: the arrival is too close to the pad`);
      if (!space.sees([pad[0], pad[1], pad[2] + 36], [arrival[0], arrival[1], arrival[2] + 36])) throw new Error(`${label}: something solid stands between the pad and its arrival`);
      for (const point of [pad, arrival])
        if (point.some((v, axis) => axis < 2 && (v < sealed.min[axis] + 32 || v > sealed.max[axis] - 32))) throw new Error(`${label}: ${point.join(" ")} is within 32 units of the city's seal`);

      out.push(...travelZone(end.key, far.key, pad, `hive_${far.key}_arrive_${end.key}`));
      out.push(
        M.pointEntity("info_teleport_destination", [arrival[0], arrival[1], round(arrival[2] + 36)], {
          targetname: `hive_${end.key}_arrive_${far.key}`,
          angles: `0 ${end.yaw} 0`,
        }),
      );
      report.push({ from: end.key, to: far.key, pad, arrival, yaw: end.yaw });
    }
  }
  return { entities: out, report };
}

// ---------------------------------------------------------------------------------------------------------

const answers = new Map();
for (const [label, path] of Object.entries(WADS)) {
  if (!existsSync(path)) continue;
  for (const name of M.wadTextureNames(readFileSync(path))) {
    const key = name.toUpperCase();
    if (!answers.has(key)) answers.set(key, []);
    answers.get(key).push(label);
  }
}
const known = new Set(answers.keys());

const cities = Object.fromEntries(Object.keys(LAYOUT).map((name) => [name, city(name)]));

for (const built of Object.values(cities)) {
  const missing = missingFor({ brushes: built.brushes, entities: built.entities }, answers);
  if (missing.length) throw new Error(`${built.cityName}: no wad answers ${missing.join(" ")}`);
}

const warp = warps(cities);

/*
 * THE TEXTURE LIGHTS. hlrad reads every info_texlights in the map, the first to name a texture winning, and the
 * compile has no lights.rad of its own, so the map carries one: every city's own keys (Alexandria's first, so
 * its values win on its textures), then what texlights.mjs measured in the cities' original compiles for the
 * textures their own lists never named. A key naming a texture no face of the merged map wears lights nothing
 * and is left out.
 */
const TEXLIGHTS_FILE = join(HERE, "texlights.json");
const TEXLIGHT_LIMIT = 200; // the engine keeps 256 key/value pairs an entity and writes past them
function mergedTexlights(worn) {
  if (!existsSync(TEXLIGHTS_FILE)) throw new Error(`no ${TEXLIGHTS_FILE}: run node texlights.mjs first`);
  const measured = JSON.parse(readFileSync(TEXLIGHTS_FILE, "utf8")).emitters;
  const keys = new Map();
  const conflicts = [];
  for (const built of Object.values(cities)) {
    for (const [raw, rawValue] of built.texlights) {
      const name = raw.trim();
      const value = String(rawValue).trim().split(/\s+/).join(" ");
      const numbers = value.split(" ").map(Number);
      if (!name || ["origin", "angles", "targetname"].includes(name.toLowerCase())) continue;
      if (![1, 3, 4].includes(numbers.length) || !numbers.every(Number.isFinite)) continue;
      const key = name.toLowerCase();
      const held = keys.get(key);
      if (held) {
        if (held.value !== value) conflicts.push(`${name}: ${held.from} ${held.value}, ${built.prefix} ${value}`);
        continue;
      }
      keys.set(key, { name, value, from: built.prefix });
    }
  }
  const fromCities = keys.size;
  for (const light of measured) if (!keys.has(light.name.toLowerCase())) keys.set(light.name.toLowerCase(), { name: light.name, value: [...light.rgb, light.value].join(" "), from: "measured" });
  const kept = [...keys.values()].filter((light) => worn.has(light.name.toLowerCase()));
  if (kept.length > TEXLIGHT_LIMIT) throw new Error(`${kept.length} texture lights; the map's info_texlights holds at most ${TEXLIGHT_LIMIT}`);
  return { kept, fromCities, measured: kept.filter((light) => light.from === "measured").length, unworn: keys.size - kept.length, conflicts };
}

/** The merged map: one world, every city's rock (cut and moved), every city's entities, the warps, and the texture lights. */
export function build() {
  const worldspawn = {
    ...readCity(CITIES.paradise).map.worldspawn,
    skyname: SKY,
    MaxRange: NO_CUT ? "8192" : "4096",
    wad: Object.values(WADS).filter(existsSync).map((path) => basename(path)),
  };
  delete worldspawn.classname;
  delete worldspawn.compiler;
  delete worldspawn._generator;
  delete worldspawn.mapversion;

  const entities = [...Object.values(cities).flatMap((built) => built.entities), ...warp.entities];
  const brushes = Object.values(cities).flatMap((built) => built.brushes);
  const worn = new Set([...texturesOf({ brushes, entities })].map((name) => String(name).toLowerCase()));
  const texlights = mergedTexlights(worn);
  // where it stands does not matter to hlrad; an arrival point is open floor inside a city's seal
  const [x, y, floor] = warp.report[0].arrival;
  entities.push(M.pointEntity("info_texlights", [x, y, round(floor + 36)], Object.fromEntries(texlights.kept.map(({ name, value }) => [name, value]))));
  return { worldspawn, brushes, entities, unswitched: unswitchLights(entities), texlights };
}

const map = build();
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `${NAME}.map`);
writeFileSync(file, M.writeMap(map));

// ---- report -----------------------------------------------------------------------------------------------
const box = (() => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const eat = (brushes) => {
    for (const brush of brushes ?? []) {
      const b = boxOf(brush);
      if (!b) continue;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], b.min[a]);
        max[a] = Math.max(max[a], b.max[a]);
      }
    }
  };
  eat(map.brushes);
  for (const entity of map.entities) eat(entity.brushes);
  return { min, max };
})();

let pointMin = [Infinity, Infinity, Infinity];
let pointMax = [-Infinity, -Infinity, -Infinity];
for (const entity of map.entities) {
  const at = numbersOf(entity.origin);
  if (at.length !== 3 || !at.every(Number.isFinite)) continue;
  for (let a = 0; a < 3; a++) {
    pointMin[a] = Math.min(pointMin[a], at[a]);
    pointMax[a] = Math.max(pointMax[a], at[a]);
  }
}

console.log(`\n=== ${NAME}`);
console.log(`  cities:`);
for (const built of Object.values(cities)) {
  console.log(`    ${built.cityName.padEnd(12)} ${String(built.brushes.length).padStart(5)} brushes  ${String(built.entities.length).padStart(4)} entities  shift ${built.shift.join(" ")}${built.droppedBelow ? `  (${built.droppedBelow} below the cut)` : ""}${built.droppedSun ? `  (${built.droppedSun} extra sun)` : ""}${built.droppedEmpty ? `  (${built.droppedEmpty} empty)` : ""}${built.droppedWeapons ? `  (${built.droppedWeapons} ground weapons dropped)` : ""}${built.reclassedFences ? `  (${built.reclassedFences} fences made solid)` : ""}${built.usablePanels ? `  (${built.usablePanels} panel${built.usablePanels === 1 ? "" : "s"} made usable)` : ""}${built.pushFixed ? `  (${built.pushFixed} push triggers fixed)` : ""}${built.snapped ? `  (${built.snapped} faces snapped)` : ""}${built.dropped ? `  (${built.dropped} slivers dropped)` : ""}${built.settled ? `  (${built.settled} contents settled)` : ""}${built.pruned ? `  (${built.pruned} pruned)` : ""}${built.deduped ? `  (${built.deduped} duplicate faces)` : ""}${built.strippedOrigins ? `  (${built.strippedOrigins} origin keys)` : ""}  (${built.shell} shell)`);
}
console.log(`  total: ${map.brushes.length} world brushes, ${map.entities.length} entities`);
console.log(`  solids  min ${box.min.map((v) => Math.round(v)).join(" ")}  max ${box.max.map((v) => Math.round(v)).join(" ")}`);
console.log(`  points  min ${pointMin.map((v) => Math.round(v)).join(" ")}  max ${pointMax.map((v) => Math.round(v)).join(" ")}`);

// A point entity outside every city's shell would seed hlbsp's leak flood in the void, however solid the
// geometry is. Every one must be inside one of the three boxes the shells enclose.
const sealedBoxes = Object.values(cities).map((built) => built.sealed);
const outside = map.entities.filter((entity) => {
  const at = numbersOf(entity.origin);
  if (at.length !== 3 || !at.every(Number.isFinite)) return false;
  return !sealedBoxes.some(({ min, max }) => at.every((value, a) => value >= min[a] - 1 && value <= max[a] + 1));
});
console.log(`  sealed  ${sealedBoxes.map(({ min, max }) => `${min.join(",")}..${max.join(",")}`).join("   ")}`);
console.log(`  points outside every sealed city: ${outside.length}${outside.length ? ` (${outside.slice(0, 5).map((e) => `${e.classname} at ${e.origin}`).join("; ")})` : ""}`);
const over = [...box.min, ...box.max, ...pointMin, ...pointMax].filter((v) => Math.abs(v) > (NO_CUT ? 8192 : 4096));
console.log(`  within +/-${NO_CUT ? 8192 : 4096}: ${over.length ? "NO -- " + over.join(" ") : "yes"}`);
console.log(`  textures used: ${texturesOf(map).size}   wads: ${Object.values(WADS).filter(existsSync).length}`);
const switched = new Set(map.entities.filter((e) => /^light/.test(e.classname ?? "") && e.targetname).map((e) => String(e.targetname)));
console.log(`  switched lights: ${switched.size} names (the engine has 32)${map.unswitched.length ? `; ${map.unswitched.length} left always on (${map.unswitched.join(" ")})` : ""}`);
if (switched.size > 32) throw new Error(`${switched.size} switched light names; lower UNSWITCHED_LIGHTS or make more lamps always on`);
const lights = map.texlights;
console.log(`  texture lights: ${lights.kept.length} (${lights.kept.length - lights.measured} from the cities' own lists, ${lights.measured} measured; ${lights.unworn} naming textures no face wears left out)${lights.conflicts.length ? `; cities disagree on ${lights.conflicts.join("; ")} -- the first kept` : ""}`);
console.log(`  travel zones (${warp.report.length} ends of ${WARP_LINKS.length} links):`);
for (const w of warp.report) {
  console.log(`    ${w.from} -> ${w.to}  zone (${w.pad.join(", ")})  arrival from ${w.to} (${w.arrival.join(", ")}) yaw ${w.yaw}`);
}

const textureNames = [...known];
const plan = M.checkPlan(map, { textures: textureNames, range: 4096 });
console.log(`\n  checkPlan: ${plan.errors.length} errors, ${plan.warnings.length} warnings`);
for (const line of plan.errors.slice(0, 12)) console.log(`    ERROR ${line}`);
for (const line of plan.warnings.slice(0, 12)) console.log(`    warn  ${line}`);
if (plan.facts?.length) for (const line of plan.facts.slice(0, 8)) console.log(`    fact  ${line}`);
console.log(`\n  wrote ${file}  (${(readFileSync(file).length / 1e6).toFixed(2)} MB)`);

// ---- compile ----------------------------------------------------------------------------------------------
const flags = process.argv.slice(2);
if (flags.includes("--compile") || flags.includes("--full") || flags.includes("--bsp")) {
  const full = flags.includes("--full");
  const geometry = flags.includes("--bsp"); // hlcsg + hlbsp only: the quickest word on the map's limits
  // SDHLT's Xash engine mode raises the file limits and writes BSP2 past the v30 ceiling. Every tool must
  // be given the same -engine, or VIS and RAD refuse the BSP2 hlbsp wrote.
  const xash = flags.includes("--xash");
  const at = flags.indexOf("--compilers");
  if (at >= 0 && !flags[at + 1]) throw new Error("--compilers needs the folder that holds your hlcsg/hlbsp/hlvis/hlrad");
  const compilerFolder = at >= 0 ? flags[at + 1] : (process.env.HIVE_COMPILERS ?? process.env.VHLT_DIR ?? COMPILERS);
  console.log(`\n  compiling ${full ? "full" : geometry ? "geometry only" : "draft"} with ${compilerFolder}${xash ? " (Xash limits, BSP2)" : ""}...`);
  const result = M.compileMap(file, {
    wads: Object.values(WADS).filter(existsSync),
    wadinclude: true,
    out: join(OUT, `${NAME}.bsp`),
    compilers: { folder: compilerFolder },
    // -threads: these tools auto-detect and use every logical core by default, pegging all
    // of them for the full, long-running duration of hlvis/hlrad on a map this size. Capped
    // here to keep peak load/heat down; costs wall-clock time, not correctness. Override with
    // HIVE_THREADS=<n> node merge.mjs ... if this is still too much, or raise it back up if not.
    //
    // hlvis and hlrad are deliberately NOT given the same -fast setting. hlrad's own -fast
    // unconditionally zeroes its bounce count after all argument parsing finishes (confirmed
    // directly in sdhlt-goldsrc-net's qrad.cpp) -- -bounce N cannot override it, the literal
    // -fast token has to be absent from hlrad's argv entirely for real bounce lighting, which
    // is why the top-level `fast` option below is always false and each tool's -fast is set
    // explicitly here instead. hlvis keeps -fast outside --full: full/accurate vis is confirmed
    // to work post-stack-overflow-fix, but costs on the order of hours at a thermally-safe
    // thread count on a map this size, so it stays full-cost opt-in via --full rather than the
    // default -- draft/--compile mode gets the ~50-second fast vis pass either way, now paired
    // with real bounce lighting instead of hlrad's own flat/no-bounce draft pass.
    args: (() => {
      const threads = String(process.env.HIVE_THREADS ?? 4);
      const eng = xash ? ["-engine", "xash"] : [];
      const perTool = [...eng, "-threads", threads];
      const visArgs = full ? perTool : [...perTool, "-fast"];
      return { hlcsg: perTool, hlbsp: perTool, hlvis: visArgs, hlrad: perTool };
    })(),
    fast: false,
    vis: !geometry,
    light: !geometry,
    timeout: { hlcsg: 900000, hlbsp: 900000, hlvis: 1800000, hlrad: 1800000 },
    keep: false,
  });
  console.log(`  bsp: ${result.bsp ?? "none"}`);
  for (const line of result.errors) console.log(`  ERROR ${line}`);
  for (const line of result.warnings.slice(0, 10)) console.log(`  warn  ${line}`);
  for (const line of result.facts) console.log(`  fact  ${line}`);
  if (result.leak) console.log(`  LEAK from ${result.leak.entity?.classname} at ${result.leak.at?.join?.(",") ?? result.leak.at}`);
  for (const log of result.logs) console.log(`  ${log.tool}: ${log.code ?? "?"} in ${log.seconds.toFixed(1)}s`);
}
