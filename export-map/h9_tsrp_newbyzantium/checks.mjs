// checks.mjs: what every build of New Byzantium is checked for, read from the map it wrote (out\<name>.map),
// the plan it was built from, and the compiled .bsp and its log when they are newer than the map.
//
//   node checks.mjs              a summary of each check and the first offenders of each
//   node checks.mjs --all        every offender
//   node checks.mjs --log=<file> the compile log to read the limits from (default: the newest out\compile-*.log)
//
// The checks:
//   floors    every walkable top face wears the floor of the space it is part of: no slab of another
//             picture set into a floor, no rock top in the carve's own grey
//   strays    no small brush standing loose on a street's floor (litter is models now, not boxes)
//   doors     a door's leaf is a door's size (taller than a player, no taller than a TS door), its
//             picture fitted to the leaf once, no see-through picture on any door but a cell's bars, its
//             edges not wearing the picture, and light on it in the compiled map
//   sounds    every looping sound stands in a space that was built, its reach fits that space, and music
//             plays only in a room, quietly, beside a thing that could play it
//   signs     no sign or banner faces into a wall
//   starts    72 places to start at least, in public ways only, spread over every district and level, each with
//             a standing player's room on its floor, clear of doors, not facing a wall
//   limits    brushes, brush models, edicts, lightdata, looping sounds, against the engine's
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M } from "../lib.mjs";
import { WADS as CITY_WADS } from "../h9_tsrp_hive/wads.mjs";
import { readAnyBsp } from "./bsp2.mjs";
import { buildCity, MUSIC, PUBLIC_KINDS, districtAt } from "./plan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAME = "h9_tsrp_newbyzantium";
const ALL = process.argv.includes("--all");
const SHOW = ALL ? Infinity : 12;
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const mapFile = join(OUT, `${NAME}.map`);
const map = M.readMap(readFileSync(mapFile, "utf8"));
const { bag } = buildCity();
const results = [];
/** One check's outcome: its name, a line of figures, and its offenders (each a line). */
const report = (name, summary, offenders = []) => {
  results.push({ name, summary, offenders });
  console.log(`\n[${offenders.length ? "FAIL" : " ok "}] ${name}: ${summary}${offenders.length ? ` -- ${offenders.length} offender(s)` : ""}`);
  for (const line of offenders.slice(0, SHOW)) console.log(`    ${line}`);
  if (offenders.length > SHOW) console.log(`    ... and ${offenders.length - SHOW} more (--all)`);
};

// ---- the textures' sizes, from the wads the map embeds -------------------------------------------------
const VALVE_WADS = new Set(["halflife", "liquids", "xeno", "decals"]);
const WADS = [
  ...Object.entries(CITY_WADS).filter(([n, p]) => !VALVE_WADS.has(n) && existsSync(p)).map(([, p]) => p),
  join(HERE, "wads", "majestic.wad"),
];
const texSize = new Map();
for (const path of WADS) {
  const b = readFileSync(path);
  const count = b.readInt32LE(4);
  const table = b.readInt32LE(8);
  for (let i = 0; i < count; i++) {
    const a = table + i * 32;
    if (b[a + 12] !== 0x43) continue;
    const pos = b.readInt32LE(a);
    const name = b.toString("latin1", a + 16, a + 32).replace(/\0[\s\S]*$/, "").toLowerCase();
    if (!texSize.has(name)) texSize.set(name, [b.readUInt32LE(pos + 16), b.readUInt32LE(pos + 20)]);
  }
}

// ---- the solids: world, detail and walls, each a box or a set of planes, in a grid on the plan --------------
const SOLID_CLASSES = new Set(["func_detail", "func_wall"]);
const solids = [];
const addSolid = (brush, source) => {
  const shape = M.shapeOf(brush);
  if (shape.faults.length || !Number.isFinite(shape.volume)) return;
  const axial = shape.faces.every((f) => f.normal && f.normal.filter((v) => Math.abs(v) > 1e-6).length === 1);
  const planes = shape.faces.filter((f) => f.normal).map((f) => [f.normal, f.dist]);
  if (brush.faces.some((f) => /^(origin|aaatrigger|clip|skip|hint)$/i.test(f.texture))) return;
  solids.push({ shape, axial, planes, source, brush, min: shape.min, max: shape.max });
};
for (const b of map.brushes) addSolid(b, "world");
for (const e of map.entities) if (SOLID_CLASSES.has(e.classname)) for (const b of e.brushes ?? []) addSolid(b, e.classname);
const CELL = 256;
const grid = new Map();
const cellKey = (i, j) => i * 100003 + j;
solids.forEach((s, id) => {
  for (let i = Math.floor(s.min[0] / CELL); i <= Math.floor((s.max[0] - 1e-6) / CELL); i++)
    for (let j = Math.floor(s.min[1] / CELL); j <= Math.floor((s.max[1] - 1e-6) / CELL); j++) {
      const k = cellKey(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(id);
    }
});
/** The solid a point is inside, or -1. */
function solidAt([x, y, z], skip = -1) {
  const list = grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!list) return -1;
  for (const id of list) {
    if (id === skip) continue;
    const s = solids[id];
    if (x <= s.min[0] || x >= s.max[0] || y <= s.min[1] || y >= s.max[1] || z <= s.min[2] || z >= s.max[2]) continue;
    if (s.axial) return id;
    if (s.planes.every(([n, d]) => n[0] * x + n[1] * y + n[2] * z - d < -0.01)) return id;
  }
  return -1;
}
const solidAtAll = (p) => solidAt(p) >= 0;
console.log(`  ${solids.length} solids read (${secs()})`);

// ---- the plan's spaces, to know which floor a point is on ------------------------------------------------
const spaces = bag.spaces.map((s) => {
  const xs = s.outline.map((p) => p[0]);
  const ys = s.outline.map((p) => p[1]);
  const tex = s.texture && typeof s.texture === "object" && !s.texture.name ? s.texture : { floor: s.texture, wall: s.texture, ceiling: s.texture };
  return { ...s, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), floorTex: tex.floor ?? "grey_creteflr2" };
});
const insideOutline = (outline, x, y) => {
  let sign = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(c) < 1e-6) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
};
/** The spaces whose floor is at z and that hold (x, y). */
const spacesOnFloor = (x, y, z) => spaces.filter((s) => Math.abs(s.floor - z) < 0.5 && x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1 && insideOutline(s.outline, x, y));
/** The spaces a point is in. */
const spacesAt = ([x, y, z]) => spaces.filter((s) => z >= s.floor && z <= s.ceiling && x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1 && insideOutline(s.outline, x, y));

// ---- floors -----------------------------------------------------------------------------------------------
{
  const STEP = 16;
  const tops = new Map(); // z -> Map("x,y" -> { tex, id })
  solids.forEach((s, id) => {
    for (const f of s.shape.faces) {
      if (!f.normal || f.normal[2] < 0.999 || f.area < 1) continue;
      const z = Math.round(f.polygon[0][2] * 100) / 100;
      const xs = f.polygon.map((p) => p[0]);
      const ys = f.polygon.map((p) => p[1]);
      // samples 5 off the 16 grid, so none lies on the line where a floor meets a wall
      for (let x = Math.floor(Math.min(...xs) / STEP) * STEP + 5; x < Math.max(...xs); x += STEP)
        for (let y = Math.floor(Math.min(...ys) / STEP) * STEP + 5; y < Math.max(...ys); y += STEP) {
          if (!insideOutline(f.polygon, x, y)) continue;
          if (solidAt([x, y, z + 1], id) >= 0 || solidAt([x, y, z + 40], id) >= 0) continue;
          if (!tops.has(z)) tops.set(z, new Map());
          tops.get(z).set(`${x},${y}`, { tex: f.texture.toLowerCase(), id });
        }
    }
  });
  // a top face whose picture is not the floor of the space it is part of: a world (carved) face is wrong
  // whenever the space over it names another floor. A face no space stands on (a sill, a ledge, a threshold) and
  // a fitting's top are floors of their own, wrong only when they lie set into a floor of another picture: most
  // of their open edge meets that floor, at their height
  const wrong = new Map(); // id -> { tex, z, want, samples, why }
  const edges = new Map(); // id -> { edge, other, z, tex, want }
  const N4 = [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]];
  let samples = 0;
  for (const [z, at] of tops) {
    for (const [key, { tex, id }] of at) {
      samples++;
      const [x, y] = key.split(",").map(Number);
      const s = solids[id];
      if (s.source === "world") {
        const over = spacesOnFloor(x, y, z);
        if (over.length) {
          if (over.some((sp) => sp.floorTex.toLowerCase() === tex)) continue;
          const w = wrong.get(id) ?? { tex, z, want: over[0].floorTex, samples: 0, why: `under ${over[0].name}` };
          w.samples++;
          wrong.set(id, w);
          continue;
        }
        // outside the city (the rock's own outside) when no space holds the air over it
        if (!spacesAt([x, y, z + 8]).length) continue;
      }
      // the patch's edge: a sample with a neighbour that is not of this brush; how much of it meets open floor
      // of another picture at this height
      const ns = N4.map(([dx, dy]) => at.get(`${x + dx},${y + dy}`));
      if (ns.every((o) => o && o.id === id)) continue;
      const e = edges.get(id) ?? { edge: 0, other: 0, z, tex, want: null };
      e.edge++;
      const odd = ns.find((o) => o && o.id !== id && o.tex !== tex);
      if (odd) {
        e.other++;
        e.want = odd.tex;
      }
      edges.set(id, e);
    }
  }
  const ODD = /^(grey_creteflr2|po_subtrash|crapwood1c|prxcncrt10a|prxcncrt5a|pkf_concrete1)$/;
  for (const [id, e] of edges) {
    if (e.other < 4 || e.other <= 0.5 * e.edge) continue;
    const s = solids[id];
    const area = (s.max[0] - s.min[0]) * (s.max[1] - s.min[1]);
    // a fitting bigger than 512 square (a landing, a walkway) is a floor of its own whatever its picture
    if (s.source !== "world" && area > 512 * 512 && !ODD.test(e.tex)) continue;
    wrong.set(id, { tex: e.tex, z: e.z, want: e.want, samples: e.other, why: `set into a floor: ${e.other} of its ${e.edge} edge samples meet ${e.want}` });
  }
  const lines = [...wrong].sort((a, b) => b[1].samples - a[1].samples).map(([id, w]) => {
    const s = solids[id];
    return `${w.tex} at z ${w.z} [${s.min.map(Math.round)} .. ${s.max.map(Math.round)}] (${s.source}), wants ${w.want}: ${w.why}, ${w.samples} samples`;
  });
  report("floors", `${samples} open floor samples on ${tops.size} heights`, lines);
}

// ---- strays: small brushes loose on a public floor ----------------------------------------------------------
{
  const PUBLIC = /^(avenue|ring|outer|street|alley|plaza|court|hall|atrium|mese|upper|quarter|sewer|well|stair)/;
  const streetsByName = new Map(bag.streets?.map?.((s) => [s.name, s]) ?? []);
  let count = 0;
  const lines = [];
  for (const s of solids) {
    if (s.source !== "func_detail") continue;
    const h = s.max[2] - s.min[2];
    const fw = s.max[0] - s.min[0];
    const fd = s.max[1] - s.min[1];
    const heap = /^(po_subtrash|crapwood1c|prxcncrt10a|prxcncrt5a|pkf_concrete1)$/i.test(s.brush.faces[0].texture);
    if (!heap && (h > 24 || fw > 32 || fd > 32)) continue;
    if (h > 40 || fw * fd > 96 * 96) continue;
    const c = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, s.min[2] + 1];
    const under = spacesAt(c).filter((sp) => Math.abs(sp.floor - s.min[2]) < 0.5);
    const pub = under.find((sp) => PUBLIC.test(sp.kind ?? sp.name) || streetsByName.has(sp.name));
    if (!pub) continue;
    // the foot of something (a column's base, a stair's first step) has more of it standing on it
    if (solidAt([c[0], c[1], s.max[2] + 2]) >= 0) continue;
    count++;
    lines.push(`${s.brush.faces[0].texture} ${Math.round(fw)}x${Math.round(fd)}x${Math.round(h)} at [${c.map(Math.round)}] in ${pub.name}`);
  }
  report("strays", `${count} small brushes on public floors`, lines);
}

// ---- doors ----------------------------------------------------------------------------------------------
const bspFile = join(OUT, `${NAME}.bsp`);
// the compiled map is read when it was compiled from this map (it is newer than it)
const bspFresh = existsSync(bspFile) && statSync(bspFile).mtimeMs >= statSync(mapFile).mtimeMs;
const bsp = bspFresh ? readAnyBsp(readFileSync(bspFile)) : null;
{
  const lines = [];
  let n = 0;
  const DOOR_CLASSES = /^func_door/;
  const texelSpan = (face, poly) => {
    const u = face.u;
    const v = face.v;
    const ss = poly.map((p) => (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / face.scale[0] + u[3]);
    const ts = poly.map((p) => (p[0] * v[0] + p[1] * v[1] + p[2] * v[2]) / face.scale[1] + v[3]);
    return [Math.min(...ss), Math.max(...ss), Math.min(...ts), Math.max(...ts)];
  };
  for (const e of map.entities) {
    if (!DOOR_CLASSES.test(e.classname)) continue;
    n++;
    const leaves = (e.brushes ?? []).filter((b) => !b.faces.some((f) => /^origin$/i.test(f.texture)));
    const shapes = leaves.map((b) => M.shapeOf(b));
    const min = [0, 1, 2].map((i) => Math.min(...shapes.map((s) => s.min[i])));
    const max = [0, 1, 2].map((i) => Math.max(...shapes.map((s) => s.max[i])));
    const height = max[2] - min[2];
    const width = Math.max(max[0] - min[0], max[1] - min[1]);
    const where = `${e.targetname ?? e.classname} at [${min.map(Math.round)}]`;
    // a cell's door and a checkpoint's portcullis are bars, and are meant to be seen through
    const cell = /^(cell|gate)_/.test(e.targetname ?? "");
    // a gate (wider than a door, or a hall's great doors that swing) is as tall as its arch
    const gate = width >= 192 || e.classname === "func_door_rotating";
    const textures = [...new Set(leaves.flatMap((b) => b.faces.map((f) => f.texture)))];
    if (!cell && (textures.some((t) => t.startsWith("{")) || e.rendermode === "4" || e.rendermode === "2")) lines.push(`${where}: see-through (${textures.join("/")}, rendermode ${e.rendermode ?? 0})`);
    if (!gate && !(height >= 96 && height <= 128)) lines.push(`${where}: ${Math.round(height)} tall`);
    if (cell || /^secret_/.test(e.targetname ?? "")) continue;
    // its picture: the two broad faces of each leaf; together they show the picture once
    for (const [k, b] of leaves.entries()) {
      const sh = shapes[k];
      const broad = sh.faces.map((f, i) => ({ f, i })).filter(({ f }) => f.normal && Math.abs(f.normal[2]) < 0.01).sort((p, q) => q.f.area - p.f.area);
      const pic = b.faces[broad[0].i].texture;
      const size = texSize.get(pic.toLowerCase());
      if (!size) {
        lines.push(`${where}: ${pic} is in no wad`);
        continue;
      }
      for (const { i } of broad.slice(0, 2)) {
        const face = b.faces[i];
        const [s0, s1, t0, t1] = texelSpan(face, sh.faces[i].polygon);
        // the leaf's share of the picture: the whole of it for one leaf, its part for a pair
        const across = (s1 - s0) / size[0];
        const down = (t1 - t0) / size[1];
        const pairOk = e.classname === "func_door_rotating" && Math.abs(across - 0.5) < 0.03;
        if (Math.abs(down - 1) > 0.03 || across > 1.03 || (leaves.length === 1 && Math.abs(across - 1) > 0.03 && !pairOk)) {
          lines.push(`${where}: ${pic} ${size.join("x")} shown ${across.toFixed(2)} across, ${down.toFixed(2)} down`);
          break;
        }
      }
      const edges = sh.faces.filter((f, i) => f.normal && Math.abs(f.normal[2]) < 0.01 && !broad.slice(0, 2).some((x) => x.i === i));
      if (edges.some((f) => f.texture === pic)) lines.push(`${where}: its edges wear ${pic}`);
    }
  }
  // light on each door, from the compiled map: the mean of its broad faces' lightmaps
  let dark = 0;
  if (bsp) {
    for (const ent of bsp.entities) {
      const keys = Object.fromEntries(ent);
      if (!/^func_door/.test(keys.classname ?? "") || !/^\*\d+$/.test(keys.model ?? "")) continue;
      const model = bsp.models[Number(keys.model.slice(1))];
      // the two broad faces (the biggest lightmaps), each on its own: a door dark on its street side is a hole
      const faces = [];
      for (let f = model.firstFace; f < model.firstFace + model.faceCount; f++) {
        const lm = M.faceLightmap(bsp, f);
        const rgb = lm?.styles[0]?.rgb;
        if (!rgb) continue;
        let sum = 0;
        for (let i = 0; i < rgb.length; i += 3) sum += Math.max(rgb[i], rgb[i + 1], rgb[i + 2]);
        faces.push({ n: rgb.length / 3, mean: sum / (rgb.length / 3) });
      }
      faces.sort((a, b) => b.n - a.n);
      const darkest = Math.min(...faces.slice(0, 2).map((f) => f.mean));
      if (faces.length && darkest < 12) {
        dark++;
        lines.push(`${keys.targetname ?? "door"} ${keys.model} at [${model.mins.map(Math.round)}]: dark on one face, light ${darkest.toFixed(1)} of 255`);
      }
    }
  }
  report("doors", `${n} doors${bsp ? `, ${dark} in the dark` : " (no fresh .bsp: light not checked)"}`, lines);
}

// ---- sounds -----------------------------------------------------------------------------------------------
{
  const lines = [];
  const REACH = { 1: Infinity, 2: 500, 4: 800, 8: 1250 };
  const props = map.entities.filter((e) => e.classname === "ts_model").map((e) => e.origin.split(" ").map(Number));
  const ray = (p, dx, dy) => {
    // in steps of 4 from 3 off the grid, so a wall 16 thick is never stepped over
    for (let d = 3; d <= 2048; d += 4) if (solidAtAll([p[0] + dx * d, p[1] + dy * d, p[2]])) return d;
    return 2048;
  };
  let loops = 0;
  for (const e of map.entities) {
    if (e.classname !== "ambient_generic") continue;
    const flags = Number(e.spawnflags ?? 0);
    if (!(flags & 32)) loops++;
    const p = e.origin.split(" ").map(Number);
    const where = `${e.message} at [${p}]`;
    if (solidAtAll(p)) {
      lines.push(`${where}: inside rock (its space was never built)`);
      continue;
    }
    const inSpace = spacesAt(p);
    if (!inSpace.length) lines.push(`${where}: in no space of the plan`);
    const reach = REACH[flags & 15] ?? 800;
    const extents = [ray(p, 1, 0), ray(p, -1, 0), ray(p, 0, 1), ray(p, 0, -1)];
    const room = [...extents].sort((p, q) => p - q)[2];
    if (MUSIC.includes(e.message)) {
      if ((flags & 15) !== 2) lines.push(`${where}: music with more than a small radius`);
      if (Number(e.health ?? 10) > 3) lines.push(`${where}: music at volume ${e.health}`);
      if (room >= 640 && !inSpace.some((sp) => /hall/.test(sp.name))) lines.push(`${where}: music not in a room (open ${room} units)`);
      if (!props.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 96)) lines.push(`${where}: music with nothing to play it`);
      // a sound reaches past its space's walls by what its radius has over the space: four times the way to
      // the walls is the most it may have
    } else if (reach !== Infinity && reach > 4 * room && room < 256) lines.push(`${where}: reach ${reach} from a spot ${room} from its walls`);
  }
  report("sounds", `${loops} looping sounds (240 at most)`, loops > 240 ? [`${loops} looping sounds`, ...lines] : lines);
}

// ---- signs -------------------------------------------------------------------------------------------------
{
  const lines = [];
  let n = 0;
  for (const e of map.entities) {
    if (!/^func_(illusionary|wall)$/.test(e.classname)) continue;
    for (const b of e.brushes ?? []) {
      const sh = M.shapeOf(b);
      const pics = sh.faces.filter((f) => f.normal && Math.abs(f.normal[2]) < 0.01 && /^\{|sign|^jap_|^hb_|^cd_sign/i.test(f.texture) && !/^\{(grate|aladder)/i.test(f.texture));
      if (!pics.length) continue;
      n++;
      const open = pics.filter((f) => {
        const c = [0, 1, 2].map((i) => f.polygon.reduce((s, p) => s + p[i], 0) / f.polygon.length);
        return !solidAtAll(c.map((v, i) => v + f.normal[i] * 4));
      });
      if (!open.length) {
        const c = [0, 1, 2].map((i) => pics[0].polygon.reduce((s, p) => s + p[i], 0) / pics[0].polygon.length);
        lines.push(`${pics[0].texture} at [${c.map(Math.round)}] faces into a wall on every side it shows`);
      }
    }
  }
  report("signs", `${n} signs and banners`, lines);
}

// ---- places to start ---------------------------------------------------------------------------------------------
{
  const lines = [];
  const starts = map.entities.filter((e) => e.classname === "info_player_deathmatch");
  const doorBoxes = map.entities.filter((e) => /^func_door/.test(e.classname)).map((e) => {
    const sh = e.brushes.map((b) => M.shapeOf(b));
    return [[0, 1, 2].map((i) => Math.min(...sh.map((x) => x.min[i]))), [0, 1, 2].map((i) => Math.max(...sh.map((x) => x.max[i])))];
  });
  const where = {};
  const pts = [];
  for (const e of starts) {
    const [x, y, oz] = e.origin.split(" ").map(Number);
    const z = oz - 36; // the floor under the body's middle
    const yaw = (Number((e.angles ?? "0 0 0").split(" ")[1] ?? e.angle ?? 0) * Math.PI) / 180;
    const at = `start at [${x},${y},${z}]`;
    const inSp = spacesAt([x, y, z + 8]);
    if (!inSp.some((sp) => PUBLIC_KINDS.has(sp.kind))) lines.push(`${at}: in no public way (${inSp.map((sp) => `${sp.name}:${sp.kind}`).join(", ") || "none"})`);
    const priv = inSp.find((sp) => /^(msr|room|hidden|door)$/.test(sp.kind));
    if (priv) lines.push(`${at}: in ${priv.name} (${priv.kind})`);
    // a standing player's box, 32 square and 72 tall, clear of every solid; a floor under it
    let blocked = null;
    for (const dx of [-15, 0, 15]) for (const dy of [-15, 0, 15]) for (const h of [2, 36, 70]) if (!blocked && solidAtAll([x + dx, y + dy, z + h])) blocked = [x + dx, y + dy, z + h];
    if (blocked) lines.push(`${at}: a body does not fit (solid at [${blocked.map(Math.round)}])`);
    if (!solidAtAll([x, y, z - 4]) && !solidAtAll([x, y, z - 12])) lines.push(`${at}: no floor under it`);
    if (doorBoxes.some(([mn, mx]) => mn[0] < x + 48 && mx[0] > x - 48 && mn[1] < y + 48 && mx[1] > y - 48 && mn[2] < z + 72 && mx[2] > z)) lines.push(`${at}: by a door`);
    // what it looks at: open floor for 128 ahead at eye height
    let wall = 0;
    for (let d = 3; d <= 128; d += 4) if (solidAtAll([x + Math.cos(yaw) * d, y + Math.sin(yaw) * d, z + 64])) {
      wall = d;
      break;
    }
    if (wall) lines.push(`${at}: faces a wall ${wall} away`);
    const level = z < -100 ? "undercity" : z >= 1000 ? "the Mese and upper city" : z > 100 ? "galleries" : Math.abs(x) < 1664 && Math.abs(y) < 1664 ? "the well" : y < -5600 ? "the canals" : districtAt(x, y);
    where[level] = (where[level] ?? 0) + 1;
    pts.push([x, y, z]);
  }
  if (starts.length < 72) lines.push(`${starts.length} places to start: 72 at least for 64 players`);
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]) < 192) lines.push(`starts at [${pts[i]}] and [${pts[j]}] stand ${Math.round(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]))} apart`);
  report("starts", `${starts.length} places to start: ${Object.entries(where).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`, lines);
}

// ---- limits ----------------------------------------------------------------------------------------------------
{
  const lines = [];
  const brushes = map.brushes.length + map.entities.reduce((s, e) => s + (e.brushes?.length ?? 0), 0);
  const models = 1 + map.entities.filter((e) => e.brushes?.length && e.classname !== "func_detail").length;
  const precached = new Set(map.entities.filter((e) => /\.(mdl|spr)$/.test(e.model ?? "")).map((e) => e.model)).size;
  const GONE = /^(light|light_spot|light_environment|func_detail|info_texlights|info_compile_parameters)$/;
  const edicts = 1 + map.entities.filter((e) => !(GONE.test(e.classname) && !e.targetname)).length;
  const loops = map.entities.filter((e) => e.classname === "ambient_generic" && !(Number(e.spawnflags ?? 0) & 32)).length;
  const props = map.entities.filter((e) => e.classname === "ts_model").length;
  if (brushes >= 32767) lines.push(`brushes ${brushes} >= 32767`);
  if (models + precached >= 2048) lines.push(`models ${models} + precached ${precached} >= 2048`);
  // 64 players, and room for what the game makes as it is played (weapons, shots, bodies)
  if (edicts >= 4098 - 64 - 400) lines.push(`edicts ${edicts}: past 4098 less 64 players and 400 for play`);
  if (loops > 240) lines.push(`looping sounds ${loops} > 240`);
  let light = "";
  const logArg = process.argv.find((a) => a.startsWith("--log="))?.slice(6);
  const logs = readdirSync(OUT).filter((f) => /^compile-.*\.log$/.test(f)).map((f) => join(OUT, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const logFile = logArg ?? logs[0];
  if (logFile && existsSync(logFile)) {
    const text = readFileSync(logFile, "utf8");
    // the last figure the log gives (hlrad's, after the light is in)
    const m = [...text.matchAll(/lightdata\s+\[variable\]\s+(\d+)\/(\d+)/g)].pop();
    if (m) {
      light = `, lightdata ${(Number(m[1]) / 1048576).toFixed(1)} of 48 MB (${logFile.split(/[\\/]/).pop()})`;
      if (Number(m[1]) >= 48 * 1048576) lines.push(`lightdata ${m[1]}`);
    }
  }
  report("limits", `brushes ${brushes}/32767, brush models ${models} + ${precached} model and sprite files /2048, edicts ${edicts}/4098 (${props} props), looping sounds ${loops}/240${light}`, lines);
}

console.log(`\n  checked in ${secs()}: ${results.filter((r) => r.offenders.length).map((r) => r.name).join(", ") || "all clear"}`);
