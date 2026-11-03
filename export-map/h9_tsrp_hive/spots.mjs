// Where a hive gate can stand in a city.
//
// A gate is three things within a short walk: an arrival anchor (where a teleport from another city puts
// you) and two pads (each sending you to one of the other two). It must stand on floor a player fits on,
// out of water, and far enough from the anchor that arriving does not immediately teleport you back out.
//
// The city's own places are the candidates: what the mapper already marked as a teleport destination, and
// the deathmatch starts. Both are written as a player origin (36 over the floor), which `restOf` measures.
import { M } from "../lib.mjs";

const FEET = 36; // a player origin is this far over the floor
const PAD = 48;   // the pad a trigger sits over
const HEIGHT = 72; // standing height
const AXES = ["radius", "x", "y", "floor"];

const valueOf = (entity) => String(entity.origin ?? "").trim().split(/\s+/).map(Number);

export const isLiquid = (space, x, y, floor) => {
  for (const [from, to, matter] of space.cut(x, y)) if (matter === "liquid" && to > floor + 1 && from < floor + HEIGHT) return true;
  return false;
};

/** A spot's footing: fits, floor at the feet, dry, and clear over the head. */
export function footing(space, x, y, feetZ, { slack = 8 } = {}) {
  const rest = M.restOf(space, [x, y, feetZ], "standing");
  if (!rest.fits || rest.floor === null) return null;
  if (rest.hang > slack) return null;
  const floor = rest.floor;
  if (isLiquid(space, x, y, floor)) return null;
  // the body must be clear for a full standing height over the floor
  const again = M.restOf(space, [x, y, floor], "standing");
  if (!again.fits || again.hang > 1) return null;
  return { x, y, floor };
}

/** The first floor under a point, however far the mapper's drop point floats above it. */
export function floorBelow(space, x, y, z, maxDrop = 512) {
  const stretches = space.blocked(x, y, "point").filter((s) => s[1] <= z + 1 && s[1] >= z - maxDrop);
  if (!stretches.length) return null;
  return stretches[stretches.length - 1][1];
}

/** Two pads around one anchor, nearest ring first, one every 22.5 degrees. */
export function padsAround(space, anchor, { want = 2, radii = [64, 80, 96, 112, 128, 144, 160, 192, 224, 256] } = {}) {
  const [ax, ay, az] = valueOf(anchor);
  const below = floorBelow(space, ax, ay, az);
  if (below === null) return null;
  const seat = footing(space, ax, ay, below, { slack: 1 });
  if (!seat) return null;
  const pads = [];
  for (const radius of radii) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const x = Math.round((ax + Math.cos(angle) * radius) / 8) * 8;
      const y = Math.round((ay + Math.sin(angle) * radius) / 8) * 8;
      if (Math.hypot(x - ax, y - ay) < PAD * 1.5) continue;
      if (pads.some((p) => Math.hypot(p.x - x, p.y - y) < PAD * 1.5)) continue;
      const floor = floorBelow(space, x, y, seat.floor + 32, 64);
      if (floor === null) continue;
      const spot = footing(space, x, y, floor, { slack: 1 });
      if (!spot) continue;
      pads.push({ ...spot, radius, angle: Math.round((angle * 180) / Math.PI) });
      if (pads.length >= want) return { anchor: { x: ax, y: ay, z: az, floor: below }, seat, pads };
    }
  }
  return { anchor: { x: ax, y: ay, z: az, floor: below }, seat, pads };
}

/** The candidate anchors of a city, best first: its own teleport destinations, then its starts. */
export function anchorsOf(map) {
  const entities = map.entities ?? [];
  const destinations = entities.filter((e) => e.classname === "info_teleport_destination" && e.origin);
  const starts = entities.filter((e) => /^info_player_(start|deathmatch)$/.test(e.classname) && e.origin);
  const named = (e) => e.targetname ?? e.classname;
  return [...destinations, ...starts].map((e) => ({ entity: e, name: named(e), origin: valueOf(e) }));
}

if (process.argv[1]?.endsWith("spots.mjs")) {
  const { CITIES, readCity } = await import("./probe.mjs");
  for (const key of Object.keys(CITIES)) {
    const { map, file } = readCity(CITIES[key]);
    console.log(`\n=== ${key}   (${file})`);
    const space = M.spaceOf(map);
    const rows = [];
    for (const anchor of anchorsOf(map)) {
      const gate = padsAround(space, anchor.entity);
      if (!gate) {
        rows.push({ name: anchor.name, at: anchor.origin.map(Math.round).join(","), pads: "-", why: "anchor does not fit" });
        continue;
      }
      rows.push({
        name: anchor.name,
        at: anchor.origin.map(Math.round).join(","),
        pads: gate.pads.map((p) => `${p.radius}@${p.angle} (${p.x},${p.y},${Math.round(p.floor)})`).join("  "),
        why: gate.pads.length < 2 ? "ONLY ONE PAD" : "",
      });
    }
    for (const row of rows) console.log(`  ${String(row.name).padEnd(22)} ${row.at.padEnd(22)} ${row.pads} ${row.why}`);
  }
}
