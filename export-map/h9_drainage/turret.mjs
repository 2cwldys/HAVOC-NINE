// The Combat Engineer's sentry turret (models/tsm_turret_blue.mdl and tsm_turret_red.mdl), built with SMAK.
//
// The RIG and the ANIMATIONS are Natural Selection's b_sentry, taken as they are: its 12 bones, its six
// sequences frame for frame (idle_off, fire, spin, deploy, retire, die), the muzzle flashes its fire sequence
// raises, its two attachments, its hit boxes and its two bone controllers (0 the head's yaw, 0 to 360; 1 the
// gun's pitch, -60 to 60), so ts_matchmode.sma drives this one exactly as it would drive that one. Nothing
// else of it is kept: the shapes and the pictures are our own, a turret patched together from scrap in a city
// that is falling down.
//
//   bone 0       the base: a scorched foot plate on three welded legs, a column, a power cell on its back
//   bone 1       the turntable and the yoke that turns with the head
//   bone 10      the gun: an armoured receiver, its mantlet, a sensor with a lit visor, cooling fins, an antenna
//   bone 11      the rotary barrels, which the fire and spin sequences turn
//   bones 2-9    the ammunition belt, a brass link on each
//
// Every part is placed in the FIRE pose (the gun level and along +x, the head's yaw at 0) and carried into
// the rest pose bone by bone, so on its bone each part sits where it was drawn in every animation.
//
//   node turret.mjs           write out\models\tsm_turret_{blue,red}.mdl, their pictures, the engine checks
//   node turret.mjs deploy    and copy them to TSM\models (what build.bat and export.bat ship)
//
// The reference: the NS model this takes its rig from, models\turret_work\b_sentry_blue.mdl, kept beside it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { K } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "models");
const TSM = join(HERE, "..", "..");
const DONOR = join(TSM, "models", "turret_work", "b_sentry_blue.mdl");
const S = K.solids;

// ---- the rig, from the donor ----------------------------------------------------------------------
const donor = readFileSync(DONOR);
const BONES = K.bones(donor).map((b) => ({ name: b.name, parent: b.parent, pos: b.pos, rot: b.rot }));
const SEQS = K.sequences(donor).map((s, i) => {
  const r = K.readSequence(donor, i);
  return {
    name: s.name,
    fps: s.fps,
    loops: s.loops,
    activity: s.activity,
    actweight: s.actweight,
    frames: r.frames,
    events: K.events(donor, i),
  };
});
const FIRE = SEQS.findIndex((s) => s.name === "fire");
// NS folds its short gun 73 degrees down while it is off, deploying and retiring; these barrels are long
// enough to run into the column there, so the fold goes no further than FOLD (the gun bone's angle about x).
const FOLD = 0.6;
for (const seq of SEQS)
  if (["idle_off", "deploy", "retire"].includes(seq.name))
    for (const frame of seq.frames) frame[10] = frame[10].map((v, k) => (k === 3 ? Math.min(v, FOLD) : v));
const firePose = K.poseAt(donor, FIRE, 0);
const restPose = K.restPose(donor);
// a point drawn in the fire pose, into the rest pose through its bone
const toRest = firePose.map((M, b) => K.mul34(restPose[b], K.inverse34(M)));
const originOf = (b) => firePose[b].map((r) => r[3]);

const YAW = originOf(1);      // the head turns about the upright through here
const PITCH = originOf(10);   // the gun tips about the y through here
const SPIN = originOf(11);    // the barrels turn about the bone's own z through here
const SPIN_AXIS = K.solids.unit([firePose[11][0][2], firePose[11][1][2], firePose[11][2][2]]);
const cx = YAW[0];
// how far out along the spin axis the barrels end, and the muzzle flash with them
const BARREL_TIP = 13.0;

// ---- the paint -------------------------------------------------------------------------------------
const SIDES = {
  blue: { hull: [0.2, 0.3, 0.42], glow: [0.45, 0.8, 1] },
  red: { hull: [0.47, 0.14, 0.1], glow: [1, 0.32, 0.16] },
};
// the atlas: 256 x 256, sixteen tiles of 64; each material one tile
const MATS = ["hull", "dark", "steel", "black", "brass", "hazard", "olive", "rust"];
const TILE = 64;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const { fbm, noise, rand } = K;
const scale3 = (c, k) => c.map((v) => v * k);
const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function paintMat(mat, x, y, side) {
  const grain = 0.86 + 0.14 * noise(x * 0.9, y * 0.9, 3);
  const blot = fbm(x * 0.07, y * 0.07, 11);
  const chip = fbm(x * 0.38, y * 0.38, 23);
  const streak = noise(x * 1.3, y * 0.04, 31);
  const bare = [0.43, 0.41, 0.38];
  const rustC = [0.38, 0.19, 0.08];
  let c;
  switch (mat) {
    case "hull": {
      c = scale3(side.hull, 0.84 + 0.22 * blot);
      // seams every half tile, rivets along them
      const lx = x % 32, ly = y % 32;
      if (lx === 0 || ly === 0) c = scale3(c, 0.55);
      if ((lx === 3 || lx === 29) && ly % 8 === 4) c = [0.5, 0.48, 0.44];
      if (chip > 0.71) c = scale3(bare, grain);
      if (blot > 0.72) c = blend(c, rustC, clamp01((blot - 0.72) * 5));
      if (streak > 0.84) c = blend(c, rustC, 0.5);
      if (rand(x, y >> 2, 41) > 0.988) c = scale3(c, 1.45);
      break;
    }
    case "dark":
      c = scale3([0.16, 0.155, 0.15], 0.8 + 0.4 * blot);
      if (chip > 0.7) c = scale3(bare, 0.7 * grain);
      if (streak > 0.8) c = blend(c, rustC, 0.4);
      break;
    case "steel":
      c = scale3([0.42, 0.42, 0.4], grain * (0.85 + 0.25 * blot));
      if (blot > 0.66) c = blend(c, rustC, clamp01((blot - 0.66) * 4));
      if (y % 6 === 0) c = scale3(c, 0.9);
      break;
    case "black":
      c = scale3([0.07, 0.07, 0.075], 0.8 + 0.5 * blot);
      break;
    case "brass":
      c = scale3([0.6, 0.46, 0.2], grain * (0.8 + 0.3 * blot));
      if (x % 8 < 1) c = scale3(c, 0.5);
      break;
    case "hazard": {
      const stripe = ((x + y) >> 3) & 1;
      c = stripe ? [0.72, 0.56, 0.1] : [0.08, 0.08, 0.07];
      c = scale3(c, 0.75 + 0.3 * blot);
      if (chip > 0.6) c = scale3(bare, 0.8 * grain);
      if (streak > 0.75) c = blend(c, rustC, 0.5);
      break;
    }
    case "olive":
      c = scale3([0.27, 0.28, 0.2], 0.8 + 0.35 * blot);
      if (chip > 0.66) c = scale3(bare, grain);
      if (y % 16 === 0) c = scale3(c, 0.6);
      break;
    case "rust":
    default:
      c = blend([0.3, 0.16, 0.08], [0.46, 0.27, 0.12], blot);
      c = scale3(c, grain);
      if (chip > 0.7) c = scale3(bare, 0.6);
      if ((x % 21 === 4 || x % 21 === 17) && y % 9 === 4) c = [0.2, 0.18, 0.16];
      break;
  }
  // soot, heavier toward each tile's foot
  const soot = clamp01(((y % TILE) / TILE - 0.55) * 1.6) * (0.5 + 0.5 * fbm(x * 0.1, y * 0.03, 53));
  return scale3(c, 1 - 0.45 * soot);
}

function picture(width, height, paint) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgb.set(paint(x, y).map((c) => Math.round(255 * clamp01(c))), (y * width + x) * 3);
  return { width, height, rgb };
}

const atlasOf = (side) =>
  picture(256, 256, (x, y) => {
    const k = (y >> 6) * 4 + (x >> 6);
    return paintMat(MATS[k] ?? "rust", x, y, side);
  });
// the visor and the lamps, drawn full bright: the side's own colour, hotter at the middle
const glowOf = (side) =>
  picture(16, 16, (x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5) / 8;
    const scan = y % 4 === 0 ? 0.75 : 1;
    return blend(side.glow, [1, 1, 1], clamp01(0.6 - d)).map((v) => v * scan);
  });

// ---- the parts -------------------------------------------------------------------------------------
// each part: [bone, solid]; a solid's mat names its tile (or "lamp", the full bright texture)
const parts = [];
const put = (bone, ...solids) => solids.forEach((s) => parts.push([bone, s]));
const up = [0, 0, 1];
const pl = (p, z = up, x = [1, 0, 0]) => S.place(p, z, x);
const dirAt = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];
const add = S.add, mul = S.mul;

// bone 0: the base: a foot plate, an armoured cowling, three heavy legs splayed from it, a column with its rams
put(0, S.plate(pl([cx, 0, 0]), S.rect(26, 26, 7.5), 1.4, { bevel: 0.5, mat: "dark" }));
put(0, S.cyl(pl([cx, 0, 1.4]), 7.4, 0, 11.5, { n: 10, r1: 4.8, bevel: 0.5, mat: "hull" }));
put(0, S.cyl(pl([cx, 0, 12.6]), 5.1, 0, 1.2, { n: 10, bevel: 0.3, mat: "dark" }));
for (const deg of [90, 210, 330]) {
  const d = dirAt(deg);
  const foot = add([cx, 0, 1.0], mul(d, 13.2));
  const top = add([cx, 0, 9.5], mul(d, 5.4));
  put(0, S.beam(foot, top, 3.2, 2.4, up, { mat: "dark", bevel: 0.4 }));
  put(0, S.box(pl(add(foot, [0, 0, -0.6]), up, d), 5.2, 4.2, 1.6, { foot: true, bevel: 0.5, mat: "steel" }));
  put(0, S.box(pl(add(top, mul(d, 0.6)), S.unit(add(mul(d, 0.8), [0, 0, 0.6])), up), 2.4, 3.6, 1.0, { mat: "steel" }));
}
for (const deg of [30, 150, 270]) {
  const d = dirAt(deg);
  const n = S.unit(add(mul(d, 0.92), [0, 0, 0.36]));
  put(0, S.plate(pl(add([cx, 0, 6.8], mul(d, 6.4)), n, up), S.rect(7.5, 6.2, 0.8), 0.6, { bevel: 0.2, mat: "rust" }));
}
put(0, S.cyl(pl([cx, 0, 13.8]), 4.1, 0, 13.0, { n: 10, r1: 3.7, mat: "dark" }));
for (const z of [17.5, 21.0, 24.5]) put(0, S.cyl(pl([cx, 0, z]), 4.5, 0, 0.8, { n: 10, bevel: 0.2, mat: "steel" }));
for (const s2 of [1, -1]) {
  put(0, S.tube([cx + 1.5, s2 * 5.0, 13.6], [cx + 1.5, s2 * 4.9, 27.2], 0.7, { mat: "steel" }));
  put(0, S.tube([cx + 1.5, s2 * 5.0, 13.6], [cx + 1.5, s2 * 5.0, 20.0], 1.05, { mat: "black" }));
}
put(0, S.cyl(pl([cx, 0, 26.6]), 5.0, 0, 4.2, { n: 10, r1: 5.6, bevel: 0.4, mat: "dark" }));
put(0, S.box(pl([cx - 10.6, 0, 1.4]), 4.6, 7.4, 9.5, { foot: true, bevel: 0.6, mat: "olive" }));
put(0, S.plate(pl([cx - 12.95, 0, 6.6], [-1, 0, 0], up), S.rect(6.0, 6.4, 0.6), 0.25, { mat: "hazard" }));
put(0, S.box(pl([cx - 10.6, 2.3, 10.9]), 1.3, 1.3, 0.9, { foot: true, mat: "lamp" }));
put(0, S.tube([cx - 9.4, -2, 10.9], [cx - 3.2, -2, 18], 0.55, { mat: "black" }));
put(0, S.tube([cx - 9.4, 1.0, 10.9], [cx - 3.2, 1.0, 22], 0.55, { mat: "black" }));

// bone 1: the turntable and the yoke
put(1, S.cyl(pl([cx, 0, 30.8]), 6.4, 0, 1.8, { n: 12, bevel: 0.4, mat: "dark" }));
const cheekPoly = (() => {
  // the cheek's outline in x and z, as the place's x and y (y = -z there)
  const p = [[-3.8, 32.6], [3.8, 32.6], [1.9, 44.6], [-2.3, 44.6]].map(([x, z]) => [x, -z]);
  return S.area2(p) < 0 ? p.reverse() : p;
})();
for (const s of [1, -1]) {
  const y0 = s > 0 ? 4.6 : -6.3;
  put(1, S.prism(S.place([0, y0, 0], [0, 1, 0], [1, 0, 0]), cheekPoly, 0, 1.7, { mat: "hull" }));
  put(1, S.cyl(S.place([PITCH[0], s * 6.3, PITCH[2]], [0, s, 0], [1, 0, 0]), 2.1, 0, 0.9, { n: 8, bevel: 0.2, mat: "steel" }));
}
put(1, S.box(pl([-8.0, 0, 32.6]), 4.0, 5.6, 6.2, { foot: true, bevel: 0.5, mat: "olive" }));
put(1, S.plate(pl([-8.0, 2.85, 35.7], [0, 1, 0], up), S.rect(3.0, 4.2, 0.4), 0.2, { mat: "hazard" }));

// bone 10: the gun
const g = (x, y, z) => [PITCH[0] + x, PITCH[1] + y, PITCH[2] + z];
put(10, S.box(pl(g(1.25, 0, 0)), 12.5, 8.4, 8.4, { bevel: 1.0, cut: 0.8, mat: "hull" }));
put(10, S.box(pl(g(1.0, 0, 4.2)), 5.6, 4.0, 2.2, { foot: true, bevel: 0.5, mat: "dark" }));
put(10, S.box(pl(g(3.85, 0, 5.3)), 0.5, 3.2, 0.9, { mat: "lamp" }));
put(10, S.plate(pl(g(7.5, 0, 0.6), [1, 0, 0], up), S.rect(11.5, 8.6, 1.6), 1.2, { bevel: 0.4, top: 0.92, mat: "dark" }));
put(10, S.plate(pl(g(8.65, 0, -3.6), [1, 0, 0], up), S.rect(1.4, 8.0), 0.15, { mat: "hazard" }));
for (const s2 of [1, -1])
  for (const z of [-2.4, -0.4, 1.6]) put(10, S.box(pl(g(-1.6, s2 * 4.45, z)), 6.2, 0.5, 0.7, { mat: "steel" }));
put(10, S.cyl(S.place(g(-5.0, 2.0, 2.4), [-1, 0, 0], up), 1.4, 0, 2.6, { n: 8, bevel: 0.3, mat: "steel" }));
put(10, S.tube(g(-3.6, -2.6, 4.2), g(-5.8, -3.2, 11.4), 0.22, { mat: "black" }));
put(10, S.box(pl(g(-5.8, -3.2, 11.4)), 0.7, 0.7, 0.7, { mat: "lamp" }));

// bone 11: the rotary barrels, about the spin axis
const sAt = (s) => add(SPIN, mul(SPIN_AXIS, s));
const sp = (s) => S.place(sAt(s), SPIN_AXIS, up);
put(11, S.cyl(sp(-3.4), 0.55, 0, 16.4, { n: 6, mat: "steel" }));
for (let k = 0; k < 3; k++) {
  const a = (k / 3) * 2 * Math.PI;
  const P = sp(0);
  const off = add(mul(P.X, Math.cos(a) * 1.3), mul(P.Y, Math.sin(a) * 1.3));
  put(11, S.tube(add(sAt(-3.4), off), add(sAt(BARREL_TIP - 0.4), off), 0.62, { mat: "dark" }));
}
put(11, S.cyl(sp(-1.2), 2.25, 0, 1.0, { n: 10, bevel: 0.2, mat: "steel" }));
put(11, S.cyl(sp(0.6), 2.3, 0, 6.6, { n: 10, mat: "dark" }));
for (const at of [1.4, 3.2, 5.0]) put(11, S.cyl(sp(at), 2.45, 0, 0.5, { n: 10, mat: "steel" }));
put(11, S.cyl(sp(9.0), 2.0, 0, 0.8, { n: 10, bevel: 0.2, mat: "steel" }));
put(11, S.cyl(sp(BARREL_TIP - 2.6), 2.05, 0, 2.6, { n: 8, bevel: 0.35, mat: "dark" }));
put(11, S.cyl(sp(BARREL_TIP - 1.8), 2.3, 0, 0.5, { n: 8, mat: "black" }));
put(11, S.cyl(sp(BARREL_TIP - 0.9), 2.3, 0, 0.5, { n: 8, mat: "black" }));

// bones 2-9: the belt, a brass link on each, laid along the belt
for (let b = 2; b <= 9; b++) {
  const p = originOf(b);
  const prev = originOf(b === 2 ? 10 : b - 1);
  const next = b === 9 ? PITCH : originOf(b + 1);
  const along = S.unit(S.sub(next, prev));
  const out = S.cross(along, [0, 1, 0]);
  put(b, S.box(S.place(p, out, along), 3.5, 3.4, 0.8, { mat: "black" }));
  put(b, S.cyl(S.place(add(p, mul(out, 0.5)), [0, 1, 0], up), 0.85, -1.9, 1.9, { n: 6, mat: "brass" }));
}

// ---- triangles, their pictures' corners, into the rest pose -----------------------------------------
function uvOf(solidTris, mat) {
  const k = MATS.indexOf(mat);
  const tx = (k % 4) * TILE, ty = Math.floor(k / 4) * TILE;
  const pts = solidTris.flat().map((c) => c.p);
  const lo = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a])));
  const hi = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));
  const ext = Math.max(...hi.map((h, a) => h - lo[a]), 1);
  const k2 = Math.min(3, (TILE - 8) / ext);
  return solidTris.map((t) => {
    const n = S.cross(S.sub(t[1].p, t[0].p), S.sub(t[2].p, t[0].p)).map(Math.abs);
    const [a, b] = n[0] >= n[1] && n[0] >= n[2] ? [1, 2] : n[1] >= n[2] ? [0, 2] : [0, 1];
    return t.map((c) => ({
      p: c.p,
      uv: [(tx + 4 + (c.p[a] - lo[a]) * k2) / 256, (ty + 4 + (hi[b] - c.p[b]) * k2) / 256],
    }));
  });
}

function meshesFor(side) {
  const atlasName = `turret_${side}.bmp`;
  const glowName = `turret_${side}_glow.bmp`;
  const atlas = { name: atlasName, ...K.indexed(atlasOf(SIDES[side]), atlasName), flags: 0 };
  const glow = { name: glowName, ...K.indexed(glowOf(SIDES[side]), glowName), flags: 4 };
  const main = [], lit = [];
  for (const [bone, solid] of parts) {
    const tris = S.trisOf(solid);
    const placed =
      solid.mat === "lamp"
        ? tris.map((t) => t.map((c, i) => ({ p: c.p, uv: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]][i] })))
        : uvOf(tris, solid.mat);
    const into = placed.map((t) => t.map((c) => ({ p: K.apply34(toRest[bone], c.p), uv: c.uv, bone })));
    (solid.mat === "lamp" ? lit : main).push(...into);
  }
  return [
    { tris: main, texture: atlas },
    { tris: lit, texture: glow },
  ];
}

// the donor's attachments, the first (where the fire sequence's muzzle flashes show) moved to the barrels' tip
const ATTACH = K.attachments(donor).map((a, i) =>
  i === 0 ? { ...a, pos: K.apply34(K.inverse34(firePose[a.bone]), add(SPIN, mul(SPIN_AXIS, BARREL_TIP + 0.4))) } : a,
);

// ---- the files --------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const shot = (src, opts) => K.render(src, { width: 360, height: 360, background: [24, 26, 30], ...opts });
const save = (name, img) => writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba));
const built = {};
for (const side of Object.keys(SIDES)) {
  const name = `tsm_turret_${side}.mdl`;
  const bytes = K.buildMdl({
    name,
    bones: BONES,
    bodyparts: [{ name: "turret", models: [{ name: "turret", meshes: meshesFor(side) }] }],
    sequences: SEQS,
    hitboxes: K.hitboxes(donor),
    attachments: ATTACH,
    controllers: K.boneControllers(donor),
  });
  writeFileSync(join(OUT, name), bytes);
  built[side] = bytes;
  console.log(`${name}  ${bytes.length} bytes, ${parts.length} parts, ${BONES.length} bones, ${SEQS.length} sequences`);
  for (const engine of ["goldsrc", "xash"]) {
    const report = K.check(bytes, engine);
    const faults = report.faults ?? report.errors ?? [];
    const warnings = report.warnings ?? [];
    console.log(`  check ${engine}: ${report.ok === false || faults.length ? "FAULT" : "ok"}  faults ${faults.length}  warnings ${warnings.length}`);
    for (const f of [...faults, ...warnings].slice(0, 8)) console.log(`    ${typeof f === "string" ? f : JSON.stringify(f)}`);
  }
  save(`tsm_turret_${side}-front.png`, shot(bytes, { view: "front", yaw: 35, pitch: 12, seq: FIRE, frame: 0 }));
  save(`tsm_turret_${side}-back.png`, shot(bytes, { view: "front", yaw: 215, pitch: 12, seq: FIRE, frame: 0 }));
}
const blue = built.blue;
save("tsm_turret-side.png", shot(blue, { view: "side", seq: FIRE, frame: 0 }));
save("tsm_turret-deploy0.png", shot(blue, { view: "front", yaw: 35, pitch: 12, seq: SEQS.findIndex((s) => s.name === "deploy"), frame: 0 }));
save("tsm_turret-aim-down.png", shot(blue, { view: "side", seq: SEQS.findIndex((s) => s.name === "idle_off"), frame: 0 }));
save("tsm_turret-die.png", shot(blue, { view: "front", yaw: 35, pitch: 12, seq: SEQS.findIndex((s) => s.name === "die"), frame: 20 }));
save("tsm_turret-ns-reference.png", shot(donor, { view: "front", yaw: 35, pitch: 12, seq: FIRE, frame: 0 }));

if (process.argv.includes("deploy")) {
  for (const side of Object.keys(SIDES)) {
    copyFileSync(join(OUT, `tsm_turret_${side}.mdl`), join(TSM, "models", `tsm_turret_${side}.mdl`));
    console.log(`deployed tsm_turret_${side}.mdl to ${join(TSM, "models")}`);
  }
}
