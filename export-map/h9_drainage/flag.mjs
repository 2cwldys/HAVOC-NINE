// The flag: what the Capture the Flag mode fights over, built with SMAK (models/tsm_flag.mdl).
//
// A banner on a pole, in two bodies of one bodypart, and three skins:
//
//   body 0  the flag standing: a steel stand, a pole with a ball on top, a cloth banner in six segments that ripple in a loop
//           ("idle"). What stands on a flag pad and what lies where a carrier fell.
//   body 1  the flag worn: a pole up the carrier's back, past his head, and the banner trailing behind it. ts_ctf.sma sets
//           the entity to MOVETYPE_FOLLOW with the carrier as its aiment, and the client then MERGES BONES BY NAME: every
//           bone this model shares with the carrier's is taken from the carrier's pose. So the pole hangs on "Bip01 Dorso2",
//           the upper spine every TS player model carries, and rides the torso through every animation (the same as
//           tsm_uplink.mdl's pack, uplink.mjs, which this follows).
//
//   skin 0  grey: nobody's, a flag lying where it fell
//   skin 1  blue: side 1's colour, and the colour of a flag side 1 holds
//   skin 2  red: side 2's colour
//
// The mode sets the skin as possession changes: a flag at its pad wears its own side's colour, the enemy carrying it turns it to the
// carrier's colour, and on the ground it goes grey. The cloth is drawn full bright, so the colour reads in the dark as well.
//
//   node flag.mjs           write out\models\tsm_flag.mdl, its pictures, and the checks for both engines
//   node flag.mjs deploy    and copy it to TSM\models (what export.bat ships) and the game's ts\models
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "models");
const TSM = join(HERE, "..", "..");
const REFERENCE = join(GAME_DIR, "ts", "models", "player", "merc", "merc.mdl");

// ---- the skeleton: the item's own root and the merc's spine (to wear it on), then the banner's chain -------------------
const ref = readFileSync(REFERENCE);
const refBones = K.bones(ref);
const CHAIN = ["Bip01", "Bip01 Bacino", "Bip01 Dorso", "Bip01 Dorso1", "Bip01 Dorso2"];
const CARRY_BONE = "Bip01 Dorso2";

const chainBones = CHAIN.map((name, i) => {
  const at = refBones.findIndex((b) => b.name === name);
  if (at < 0) throw new Error(`${REFERENCE} has no bone ${name}`);
  const b = refBones[at];
  const parentName = b.parent >= 0 ? refBones[b.parent].name : null;
  if (i === 0 ? parentName !== null : parentName !== CHAIN[i - 1])
    throw new Error(`${name}'s parent is ${parentName}, not ${i ? CHAIN[i - 1] : "nothing"}: the chain is not as drawn`);
  return { name, parent: i === 0 ? -1 : i, pos: b.pos, rot: b.rot };
});

// the banner: SEGS pieces of SEG_W across, hung from the top of the pole, each piece on a bone that is the last one's child
const SEGS = 6;
const SEG_W = 6;
const POLE_H = 76; // the standing pole's height above its stand: a flag as tall as a player
const CLOTH_H = 24; // the banner's height
const CLOTH_TOP = POLE_H - 1;
const CLOTH_X0 = 1.3; // the banner starts this far off the pole's axis
const clothBones = Array.from({ length: SEGS }, (_, i) => ({
  name: `flag_cloth${i + 1}`,
  parent: i === 0 ? 0 : 6 + i - 1,
  pos: i === 0 ? [CLOTH_X0, 0, CLOTH_TOP - CLOTH_H] : [SEG_W, 0, 0],
  rot: [0, 0, 0],
}));
const BONES = [{ name: "flag_root", parent: -1, pos: [0, 0, 0], rot: [0, 0, 0] }, ...chainBones, ...clothBones];
const clothBone = (i) => `flag_cloth${i + 1}`;

// ---- where the merc's back is, standing (as uplink.mjs finds it) ----------------------------------------------
const seqs = K.sequences(ref);
const STAND = Math.max(0, seqs.findIndex((s) => s.name === "standard_idle"));
const standing = K.poseAt(ref, STAND, 0);
const carryAt = refBones.findIndex((b) => b.name === CARRY_BONE);
const toRest = K.mul34(K.restPose(ref)[carryAt], K.inverse34(standing[carryAt]));
const torso = new Set(["Bip01 Dorso", "Bip01 Dorso1", "Bip01 Dorso2", "Bip01 Dorso3"].map((n) => refBones.findIndex((b) => b.name === n)));
const standTris = K.posed(ref, { seq: STAND, frame: 0 }).tris;
const back = { x: Infinity, z0: Infinity, z1: -Infinity };
let headTop = -Infinity; // the top of the merc's head, standing: the worn pole stands a little over it
for (const t of standTris)
  for (const c of t.c) {
    headTop = Math.max(headTop, c.p[2]);
    if (!torso.has(c.bone)) continue;
    back.x = Math.min(back.x, c.p[0]);
    back.z0 = Math.min(back.z0, c.p[2]);
    back.z1 = Math.max(back.z1, c.p[2]);
  }
if (!Number.isFinite(back.x)) throw new Error("no torso corners found on the merc");

// ---- the pictures -------------------------------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function picture(width, height, paint) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgb.set(paint(x, y).map((c) => Math.round(255 * clamp01(c))), (y * width + x) * 3);
  return { width, height, rgb };
}

/** The banner's cloth, 64 x 32: a field with a border, and a bold chevron pointing at the pole's side, with a little weave. */
const cloth = (field, mark) =>
  picture(64, 32, (x, y) => {
    const weave = 0.93 + 0.07 * hash(x >> 1, y >> 1, 5);
    const edge = x < 2 || x > 61 || y < 2 || y > 29;
    // a chevron: |y - 16| within a band of the line that runs from the pole side (x small) toward the free end
    const chev = Math.abs(Math.abs(y - 16) - (x - 14) * 0.55);
    const onChevron = x >= 14 && x <= 50 && chev < 2.6;
    const disc = (x - 54) ** 2 + (y - 16) ** 2 <= 9;
    if (edge) return field.map((k) => k * 0.55 * weave);
    if (onChevron || disc) return mark.map((k) => k * weave);
    return field.map((k) => k * weave);
  });

/** The metal of the stand and the pole, 32 x 32: brushed steel with a few scuffs. */
const METAL = picture(32, 32, (x, y) => {
  const brushed = 0.82 + 0.18 * hash(x, y >> 2, 3);
  const scuff = hash(x, y, 9) > 0.97 ? 0.18 : 0;
  return [0.52, 0.55, 0.6].map((k) => k * brushed + scuff);
});

const NEUTRAL = [
  [0.7, 0.72, 0.76],
  [0.3, 0.32, 0.38],
];
const BLUE = [
  [0.03, 0.34, 0.95],
  [0.92, 0.96, 1.0],
];
const RED = [
  [0.95, 0.1, 0.08],
  [1.0, 0.92, 0.88],
];
const clothTex = (c, name) => ({ name, ...K.indexed(cloth(c[0], c[1]), name), flags: 4 }); // full bright
const metalTex = { name: "flag_metal.bmp", ...K.indexed(METAL, "flag_metal.bmp"), flags: 0 };
const grey = clothTex(NEUTRAL, "flag_cloth.bmp");
const blue = clothTex(BLUE, "flag_cloth_blue.bmp");
const red = clothTex(RED, "flag_cloth_red.bmp");

// ---- the shapes ----------------------------------------------------------------------------------------------------
const whole = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98 };

/** A quad a..d (counter-clockwise seen from outside) as two triangles, its picture the zone stretched over it. */
function quad(a, b, c, d, z, bone) {
  const uv = [[z.x0, z.y1], [z.x1, z.y1], [z.x1, z.y0], [z.x0, z.y0]];
  const corner = (p, k) => ({ p, uv: uv[k], bone });
  return [
    [corner(a, 0), corner(b, 1), corner(c, 2)],
    [corner(a, 0), corner(c, 2), corner(d, 3)],
  ];
}

/** An upright prism of n sides, radius r about (cx, cy), from z0 to z1, with its caps. */
function prism(cx, cy, z0, z1, r, n, bone, taper = 1) {
  const out = [];
  const ring = (k, rr) => [cx + rr * Math.cos((2 * Math.PI * k) / n), cy + rr * Math.sin((2 * Math.PI * k) / n)];
  for (let k = 0; k < n; k++) {
    const p0 = ring(k, r);
    const p1 = ring(k + 1, r);
    const q0 = ring(k, r * taper);
    const q1 = ring(k + 1, r * taper);
    out.push(...quad([p0[0], p0[1], z0], [p1[0], p1[1], z0], [q1[0], q1[1], z1], [q0[0], q0[1], z1], whole, bone));
    // the top cap faces up (counter-clockwise from above): the centre, this corner, the next; the bottom one the other way
    out.push([
      { p: [cx, cy, z1], uv: [0.5, 0.5], bone },
      { p: [q0[0], q0[1], z1], uv: [0.2, 0.2], bone },
      { p: [q1[0], q1[1], z1], uv: [0.8, 0.2], bone },
    ]);
    out.push([
      { p: [cx, cy, z0], uv: [0.5, 0.5], bone },
      { p: [p1[0], p1[1], z0], uv: [0.8, 0.8], bone },
      { p: [p0[0], p0[1], z0], uv: [0.2, 0.8], bone },
    ]);
  }
  return out;
}

/** A ball: an octahedron of radius r about (cx, cy, cz). */
function ball(cx, cy, cz, r, bone) {
  const top = [cx, cy, cz + r];
  const bot = [cx, cy, cz - r];
  const e = [[cx + r, cy, cz], [cx, cy + r, cz], [cx - r, cy, cz], [cx, cy - r, cz]];
  const out = [];
  const corner = (p, uv) => ({ p, uv, bone });
  for (let k = 0; k < 4; k++) {
    const a = e[k];
    const b = e[(k + 1) % 4];
    out.push([corner(top, [0.5, 0.1]), corner(a, [0.2, 0.9]), corner(b, [0.8, 0.9])]);
    out.push([corner(bot, [0.5, 0.9]), corner(b, [0.8, 0.1]), corner(a, [0.2, 0.1])]);
  }
  return out;
}

/**
 * The flag in its own space: z up, the banner trailing toward +x from the pole. The banner is two sided (the game draws one side of a
 * face), each of its SEGS pieces on its own bone when `bones` is given (the standing flag), else on the one bone `fixed`. `at(p)`
 * moves every point (the worn one is set on the carrier's back).
 */
function flagParts({ steel, cloths, at, standing: stand, poleFoot, poleTop }) {
  const metal = [];
  if (stand) {
    metal.push(...prism(0, 0, 0, 3, 11, 8, steel, 0.8)); // the stand: a low octagonal plate
  }
  metal.push(...prism(0, 0, poleFoot, poleTop, 1.1, 8, steel));
  metal.push(...ball(0, 0, poleTop + 2.2, 2.4, steel));
  const clothTris = [];
  const top = poleTop - 1;
  const bottom = top - CLOTH_H;
  for (let i = 0; i < SEGS; i++) {
    const xa = CLOTH_X0 + i * SEG_W;
    const xb = xa + SEG_W;
    const bone = stand ? clothBone(i) : CARRY_BONE;
    const z = { x0: (i + 0.0) / SEGS, x1: (i + 1.0) / SEGS, y0: 0.0, y1: 1.0 };
    // the front, facing -y; the back, facing +y, the picture reversed along with its corners
    clothTris.push(...quad([xa, 0, bottom], [xb, 0, bottom], [xb, 0, top], [xa, 0, top], z, bone));
    clothTris.push(...quad([xb, 0, bottom], [xa, 0, bottom], [xa, 0, top], [xb, 0, top], z, bone));
  }
  const move = (tris) => tris.map((t) => t.map((c) => ({ ...c, p: at(c.p) })));
  return [
    { tris: move(metal), texture: metalTex },
    { tris: move(clothTris), texture: cloths },
  ];
}

// body 0: standing at the origin, the banner trailing toward +x
const standing0 = flagParts({ steel: "flag_root", cloths: grey, at: (p) => p, standing: true, poleFoot: 3, poleTop: POLE_H });

// body 1: on the back. The pole runs up behind the carrier from his lower back to well over his head; the banner trails backwards from it.
// Its local x is "behind the back", so a point is back.x - GAP - x in the merc's own standing space, then carried into the rest space
// through the spine bone as uplink.mjs does.
const GAP = 0.8;
const worn = flagParts({
  steel: CARRY_BONE,
  cloths: grey,
  standing: false,
  poleFoot: back.z0 - 6, // from the small of the back...
  poleTop: headTop + 14, // ...to a little over his head
  at: ([x, y, z]) => K.apply34(toRest, [back.x - GAP - x, y, z]),
});

// ---- the banner's ripple ---------------------------------------------------------------------------------------------
// A looping animation's last frame is taken for its first, so the ripple runs FRAMES steps and the last frame is the first again.
const FRAMES = 24;
const rest = BONES.map((b) => [...b.pos, ...b.rot]);
const rippleAt = (f) =>
  rest.map((values, i) => {
    const k = i - 6; // which banner piece, when it is one
    if (k < 0 || k >= SEGS) return values;
    const phase = (f / FRAMES) * 2 * Math.PI - k * 0.85;
    const swing = (0.1 + 0.025 * k) * Math.sin(phase); // about the pole's axis: the piece swings out of the banner's plane and back
    const lift = 0.03 * Math.sin(phase + 1.2); // and a little about its own axis along the banner
    return [values[0], values[1], values[2], lift, 0, swing];
  });
const frames = [...Array.from({ length: FRAMES }, (_, f) => rippleAt(f)), rippleAt(0)];

const bytes = K.buildMdl({
  name: "tsm_flag.mdl",
  bones: BONES,
  bodyparts: [
    {
      name: "flag",
      models: [
        { name: "standing", meshes: standing0 },
        { name: "worn", meshes: worn },
      ],
    },
  ],
  skins: [{ "flag_cloth.bmp": blue }, { "flag_cloth.bmp": red }],
  sequences: [{ name: "idle", fps: 10, loops: true, frames }],
});

mkdirSync(OUT, { recursive: true });
const file = join(OUT, "tsm_flag.mdl");
writeFileSync(file, bytes);
console.log(`tsm_flag.mdl  ${bytes.length} bytes, ${BONES.length} bones, back of the merc at x ${back.x.toFixed(2)}, spine z ${back.z0.toFixed(1)}..${back.z1.toFixed(1)}, head top ${headTop.toFixed(1)}`);

for (const engine of ["goldsrc", "xash"]) {
  const report = K.check(bytes, engine);
  const faults = report.faults ?? report.errors ?? [];
  const warnings = report.warnings ?? [];
  console.log(`check ${engine}: ${report.ok === false || faults.length ? "FAULT" : "ok"}  faults ${faults.length}  warnings ${warnings.length}`);
  for (const f of [...faults, ...warnings].slice(0, 8)) console.log(`  ${typeof f === "string" ? f : JSON.stringify(f)}`);
}

// ---- pictures: the standing flag in each skin, the worn one on the merc ---------------------------------------------
const shot = (src, opts) => K.render(src, { width: 320, height: 320, background: [24, 26, 30], ...opts });
const save = (name, img) => writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba));
for (const [skin, name] of [[0, "grey"], [1, "blue"], [2, "red"]]) {
  save(`tsm_flag-standing-${name}.png`, shot(bytes, { view: "side", yaw: 60, body: 0, seq: 0, frame: 6, skin }));
}
const within = K.framing(ref, [{ seq: STAND, frame: 0 }]);
const mergedPose = BONES.map((b) => {
  const i = refBones.findIndex((r) => r.name === b.name);
  return i >= 0 ? standing[i] : [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
});
for (const [name, view, yaw] of [["side", "side", 0], ["back", "front", 180]]) {
  const merc = shot(ref, { view, yaw, seq: STAND, frame: 0, within });
  const pack = K.render(bytes, { width: 320, height: 320, background: [0, 0, 0], view, yaw, body: 1, skin: 1, pose: mergedPose, within });
  for (let i = 0; i < merc.rgba.length; i += 4)
    if (pack.rgba[i] + pack.rgba[i + 1] + pack.rgba[i + 2] > 0) merc.rgba.set(pack.rgba.subarray(i, i + 3), i);
  save(`tsm_flag-on-merc-${name}.png`, merc);
}

if (process.argv.includes("deploy")) {
  for (const dir of [join(TSM, "models"), join(GAME_DIR, "ts", "models")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(file, join(dir, "tsm_flag.mdl"));
    console.log(`deployed tsm_flag.mdl to ${dir}`);
  }
}
