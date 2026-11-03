// The uplink: the one thing the Capture the Uplink mode fights over, built with SMAK (models/tsm_uplink.mdl).
//
// A battered field case with an antenna and a lit screen, in two bodies of one bodypart:
//
//   body 0  the case standing on the ground, turning slowly on its own bone ("uplink_root"): what lies in
//           the world while nobody carries it.
//   body 1  the same case worn on a carrier's back. ts_uplink.sma sets the entity to MOVETYPE_FOLLOW with
//           the carrier as its aiment, and the client then MERGES BONES BY NAME: every bone this model shares
//           with the carrier's is taken from the carrier's pose. So the pack hangs on "Bip01 Dorso2", the
//           upper spine every TS player model carries (the stock merc and the server's own repuheavy line
//           both do), and rides the torso through every animation.
//
// The spine chain is copied from the stock merc, with its rest values. WHERE THE BACK IS comes from the merc
// STANDING (its standard_idle), not at rest: at rest a Biped lies turned a quarter round, and the engine
// only ever draws the pack merged onto a carrier's animated spine. Standing, the merc faces +x, so its back
// is its lowest x across the spine; the case is placed there and then carried, through the spine bone,
// into the rest space buildMdl takes its corners in (the bone's rest matrix times the inverse of its
// standing one), so that on the bone it sits exactly where it was placed on the standing merc.
//
//   node uplink.mjs           write out\models\tsm_uplink.mdl, its pictures, and the checks for both engines
//   node uplink.mjs deploy    and copy it to TSM\models (what export.bat ships) and the game's ts\models
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "models");
const TSM = join(HERE, "..", "..");
const REFERENCE = join(GAME_DIR, "ts", "models", "player", "merc", "merc.mdl");

// ---- the skeleton --------------------------------------------------------------------------------
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
  // in the new list the root of the item comes first, so every index here is one further on
  return { name, parent: i === 0 ? -1 : i, pos: b.pos, rot: b.rot };
});
const BONES = [{ name: "uplink_root", parent: -1, pos: [0, 0, 0], rot: [0, 0, 0] }, ...chainBones];

// ---- where the merc's back is, standing -----------------------------------------------------------
const seqs = K.sequences(ref);
const STAND = Math.max(0, seqs.findIndex((s) => s.name === "standard_idle"));
const standing = K.poseAt(ref, STAND, 0);
const carryAt = refBones.findIndex((b) => b.name === CARRY_BONE);
// from the standing merc's space into the rest space, through the spine bone the pack is merged onto
const toRest = K.mul34(K.restPose(ref)[carryAt], K.inverse34(standing[carryAt]));

const torso = new Set(["Bip01 Dorso", "Bip01 Dorso1", "Bip01 Dorso2", "Bip01 Dorso3"].map((n) => refBones.findIndex((b) => b.name === n)));
const standTris = K.posed(ref, { seq: STAND, frame: 0 }).tris;
const back = { x: Infinity, z0: Infinity, z1: -Infinity, y0: Infinity, y1: -Infinity };
for (const t of standTris)
  for (const c of t.c) {
    if (!torso.has(c.bone)) continue;
    back.x = Math.min(back.x, c.p[0]);
    back.z0 = Math.min(back.z0, c.p[2]);
    back.z1 = Math.max(back.z1, c.p[2]);
    back.y0 = Math.min(back.y0, c.p[1]);
    back.y1 = Math.max(back.y1, c.p[1]);
  }
if (!Number.isFinite(back.x)) throw new Error("no torso corners found on the merc");

// ---- the pictures -----------------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function hash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A picture painted pixel by pixel: paint(x, y) -> [r, g, b] 0 to 1. */
function picture(width, height, paint) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgb.set(paint(x, y).map((c) => Math.round(255 * clamp01(c))), (y * width + x) * 3);
  return { width, height, rgb };
}

/*
 * The case's picture, 64 x 64: the left half the case's broad faces (gunmetal, scuffed, an edge band and
 * rivets), the top right its narrow sides and top (the same, darker), the bottom right the antenna and
 * straps (black rubber and steel).
 */
const CASE = picture(64, 64, (x, y) => {
  const n = hash(x, y, 7);
  const grime = 0.85 + 0.15 * hash(x >> 2, y >> 2, 3);
  if (x < 32) {
    // broad face: a raised edge band, two rivets a corner, scratches
    const edge = x < 2 || x > 29 || y < 2 || y > 61;
    const rivet = [[5, 5], [26, 5], [5, 58], [26, 58]].some(([rx, ry]) => (x - rx) ** 2 + (y - ry) ** 2 <= 2);
    const scratch = hash(x, y >> 1, 11) > 0.985;
    let c = [0.27, 0.29, 0.26].map((k) => k * grime + 0.05 * n);
    if (edge) c = c.map((k) => k * 0.6);
    if (rivet) c = [0.52, 0.5, 0.45];
    if (scratch) c = c.map((k) => k + 0.18);
    // a stencilled stripe of hazard yellow across the middle, worn
    if (y > 40 && y < 46 && hash(x, y, 5) > 0.25) c = [0.62, 0.5, 0.12].map((k) => k * grime);
    return c;
  }
  if (y < 32) {
    // narrow sides and the top
    const c = [0.21, 0.22, 0.2].map((k) => k * grime + 0.04 * n);
    return x % 8 === 0 ? c.map((k) => k * 0.7) : c;
  }
  // antenna and straps
  if (x < 48) return [0.07, 0.07, 0.08].map((k) => k + 0.04 * n);
  return [0.55, 0.57, 0.6].map((k) => k * (0.8 + 0.2 * n));
});

/** The screen, 16 x 16, drawn full bright: a signal trace over a dark green field. */
const GLOW = picture(16, 16, (x, y) => {
  const trace = Math.abs(y - (8 + 4 * Math.sin((x / 16) * 2 * Math.PI * 1.5))) < 1.1;
  const grid = x % 4 === 0 || y % 4 === 0;
  if (trace) return [0.55, 1, 0.75];
  return grid ? [0.04, 0.22, 0.12] : [0.02, 0.1, 0.06];
});

const caseTex = { name: "uplink_case.bmp", ...K.indexed(CASE, "uplink_case.bmp"), flags: 0 };
const glowTex = { name: "uplink_glow.bmp", ...K.indexed(GLOW, "uplink_glow.bmp"), flags: 4 };

// ---- the shapes -------------------------------------------------------------------------------------
/** UVs in 0..1 from pixels of a 64 x 64 picture: a zone [x0, y0, x1, y1]. */
const zone = (x0, y0, x1, y1) => ({ x0: x0 / 64, y0: y0 / 64, x1: x1 / 64, y1: y1 / 64 });
const BROAD = zone(1, 1, 31, 63);
const SIDE = zone(33, 1, 63, 31);
const RUBBER = zone(33, 33, 47, 63);
const STEEL = zone(49, 33, 63, 63);

/** A quad a..d (counter-clockwise seen from outside) as two triangles, its picture the zone stretched over it. */
function quad(a, b, c, d, z, bone) {
  const uv = [[z.x0, z.y1], [z.x1, z.y1], [z.x1, z.y0], [z.x0, z.y0]];
  const corner = (p, k) => ({ p, uv: uv[k], bone });
  return [
    [corner(a, 0), corner(b, 1), corner(c, 2)],
    [corner(a, 0), corner(c, 2), corner(d, 3)],
  ];
}

/** A box from min to max: its two broad faces (+-x) on `broad`, the other four on `side`. */
function box(min, max, broad, side, bone) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    ...quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], broad, bone), // +x
    ...quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], broad, bone), // -x
    ...quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], side, bone), // -y
    ...quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], side, bone), // +y
    ...quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side, bone), // +z
    ...quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], side, bone), // -z
  ];
}

/**
 * The case standing on the ground of its own space, x the way its screen faces: the body, two straps round
 * it, the antenna up from its top corner, the screen on the +x face. `at(p)` moves every point (the worn
 * one is turned to face backwards and set on the back).
 */
function caseParts(bone, at) {
  const W = 6.5; // half its width (y)
  const D = 3; // half its depth (x)
  const H = 17; // its height (z)
  const caseTris = [
    ...box([-D, -W, 0], [D, W, H], BROAD, SIDE, bone),
    // two straps round it, standing proud of it
    ...box([-D - 0.3, -W - 0.3, 3], [D + 0.3, W + 0.3, 4.5], RUBBER, RUBBER, bone),
    ...box([-D - 0.3, -W - 0.3, 12], [D + 0.3, W + 0.3, 13.5], RUBBER, RUBBER, bone),
    // the antenna: a socket and a mast
    ...box([-1, W - 2.5, H], [1, W - 0.5, H + 1.5], STEEL, STEEL, bone),
    ...box([-0.3, W - 1.8, H + 1.5], [0.3, W - 1.2, H + 13], STEEL, STEEL, bone),
  ];
  // the screen, a hair off the +x face, between the straps
  const S = D + 0.08;
  const glowTris = quad([S, -4.5, 6], [S, 4.5, 6], [S, 4.5, 11], [S, -4.5, 11], zone(0, 0, 64, 64), bone);
  const move = (tris) => tris.map((t) => t.map((c) => ({ ...c, p: at(c.p) })));
  return [
    { tris: move(caseTris), texture: caseTex },
    { tris: move(glowTris), texture: glowTex },
  ];
}

// body 0: standing at the origin, screen to +x
const lying = caseParts("uplink_root", (p) => p);

// body 1: on the back, turned half round about z (x and y both reversed: a turn, not a mirror, so every
// face keeps facing out) so that its screen faces backwards; its own back (-x) a little off the merc's
// back, its middle at the height of the spine's middle, a touch high, as a pack is worn.
const GAP = 0.6;
const midZ = (back.z0 + back.z1) / 2 + 3;
const worn = caseParts(CARRY_BONE, ([x, y, z]) => K.apply34(toRest, [back.x - GAP - (x + 3), -y, midZ - 8.5 + z]));

// ---- the turn of the one on the ground --------------------------------------------------------------
// A looping animation's last frame is taken for its first (the engine plays up to it and starts again), so
// the turn runs over FRAMES steps and the last frame is the first again, exactly.
const FRAMES = 40;
const rest = BONES.map((b) => [...b.pos, ...b.rot]);
const turnAt = (f) =>
  rest.map((values, i) =>
    i === 0 ? [0, 0, 1 + Math.sin((f / FRAMES) * 2 * Math.PI) * 1.2, 0, 0, (f / FRAMES) * 2 * Math.PI] : values,
  );
const frames = [...Array.from({ length: FRAMES }, (_, f) => turnAt(f)), turnAt(0)];

const bytes = K.buildMdl({
  name: "tsm_uplink.mdl",
  bones: BONES,
  bodyparts: [
    {
      name: "uplink",
      models: [
        { name: "ground", meshes: lying },
        { name: "worn", meshes: worn },
      ],
    },
  ],
  sequences: [{ name: "idle", fps: 10, loops: true, frames }],
});

mkdirSync(OUT, { recursive: true });
const file = join(OUT, "tsm_uplink.mdl");
writeFileSync(file, bytes);
console.log(`tsm_uplink.mdl  ${bytes.length} bytes, ${BONES.length} bones, back of the merc at x ${back.x.toFixed(2)}, spine z ${back.z0.toFixed(1)}..${back.z1.toFixed(1)}`);

for (const engine of ["goldsrc", "xash"]) {
  const report = K.check(bytes, engine);
  const faults = report.faults ?? report.errors ?? [];
  const warnings = report.warnings ?? [];
  console.log(`check ${engine}: ${report.ok === false || faults.length ? "FAULT" : "ok"}  faults ${faults.length}  warnings ${warnings.length}`);
  for (const f of [...faults, ...warnings].slice(0, 8)) console.log(`  ${typeof f === "string" ? f : JSON.stringify(f)}`);
}

// ---- pictures: each body on its own, and the worn one over the merc to one scale ----------------------
const shot = (src, opts) => K.render(src, { width: 320, height: 320, background: [24, 26, 30], ...opts });
const save = (name, img) => writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba));
save("tsm_uplink-ground.png", shot(bytes, { view: "front", yaw: 35, body: 0, seq: null }));
save("tsm_uplink-worn.png", shot(bytes, { view: "side", yaw: 90, body: 1, seq: null }));

// the merc standing and the pack merged onto him, as the client draws it: the pack posed with the merc's
// own standing matrices for every bone the two share (the item's own root at rest), from the side and the
// back, both drawn within the merc's frame so they line up. Never from the front: the two pictures share no
// depth, so the pack would be painted over the body that hides it.
const within = K.framing(ref, [{ seq: STAND, frame: 0 }]);
const mergedPose = BONES.map((b) => {
  const i = refBones.findIndex((r) => r.name === b.name);
  return i >= 0 ? standing[i] : [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
});
for (const [name, view, yaw] of [["side", "side", 0], ["back", "front", 180]]) {
  const merc = shot(ref, { view, yaw, seq: STAND, frame: 0, within });
  const pack = K.render(bytes, { width: 320, height: 320, background: [0, 0, 0], view, yaw, body: 1, pose: mergedPose, within });
  for (let i = 0; i < merc.rgba.length; i += 4)
    if (pack.rgba[i] + pack.rgba[i + 1] + pack.rgba[i + 2] > 0) merc.rgba.set(pack.rgba.subarray(i, i + 3), i);
  save(`tsm_uplink-on-merc-${name}.png`, merc);
}

if (process.argv.includes("deploy")) {
  for (const dir of [join(TSM, "models"), join(GAME_DIR, "ts", "models")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(file, join(dir, "tsm_uplink.mdl"));
    console.log(`deployed tsm_uplink.mdl to ${dir}`);
  }
}
