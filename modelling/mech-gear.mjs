// The mech's kit: the fittings that make the machine read as a machine at
// loadout distance. Geometry only ever added on top -- bones, hit boxes and
// the 171 sequences are untouched.
//
//     import { addGear, STYLE_MSR, STYLE_INS } from "./mech-gear.mjs";
//
// What the probe established before a number was chosen (mech-fit.mjs,
// mech-move.mjs -- rerun them if this ever looks wrong):
//   * his right arm is -y (DX). The cannon chain Braccio superiore ->
//     Avambraccio -> Mano NEVER moves relative to itself -- 0.0 degrees over
//     all 171 sequences -- so every piece on one arm can hang on one bone.
//     The whole arm swings from the shoulder (up to 55 degrees in the death
//     spins), so the pauldrons ride the arm, which is where a mech's shoulder
//     armour belongs.
//   * the forearm bones are at y 33 out, z 27.9; the cannon block is y -15..-40,
//     x -13..24, z 18..36; the right barrels run x 20..46 on Bip01 DX Mano and
//     the little hand fingers sit x 23..27, z 25.6..29.2 -- the new barrels all
//     start at x 24 or run past the fingers so nothing swallows the hand.
//   * the dome and the whole upper back are Bip01 Dorso3 (island dump), and
//     Dorso2->Dorso3 only ever bends 7.4 degrees, so the back wires stay on
//     Dorso3 top to bottom. Rear body for the hanging cables: x -8.5..-2.2 at
//     z 0..4; the legs swing at |y| > 13, so cables inside |y| 11 never meet
//     a leg.
//
// Boxes are 4-sided tubes with seam pi/4 (r4() is the corner-to-half-extent
// conversion), drums and brakes are turned, cables are tapered tubes with the
// end at radius 0.25 -- all of it with the workshop's own picture, so every
// face comes out of the kit with its uv already on a zone.
//
// The picture is a second job. The meshes build their uvs from zones and the
// zones are what these paint calls fill: one 256x256 sheet serves every piece,
// so the whole kit costs the file ONE more texture. Both arms, the pelvis
// cables and the back wires are all directions of the same picture.
//
// THE NORM TABLE IS THE BUDGET. check.mjs counts verts AND normals per
// submodel, 2048 each, and the body already spends 1710 of the normals. That
// is why the whole kit is ONE mesh (a second mesh re-tables every direction it
// repeats) and why the cables are 3-sided and the long runs are single bands:
// a bending tube splits its normals per band, so each extra ring has to earn
// its place. mech-gear-test.mjs prints the running totals.
import { K, clamp, POSE } from "./lib.mjs";

const SIZE = 256;

// corner radius for a square tube of half-extents (up, side)
const r4 = (up, side) => [up * Math.SQRT2, side * Math.SQRT2];

// multiply a colour by a colour, channel by channel. workshop.times takes a
// single factor; handing it an array comes back as NaN, which the sheet writes
// as black -- the first build of this kit painted every steel zone black that
// way.
const shade = (c, k) => [clamp(c[0] * k[0]), clamp(c[1] * k[1]), clamp(c[2] * k[2])];

// ── the two liveries for the kit ───────────────────────────────────────────
export const STYLE_MSR = {
  tint: [0.84, 0.93, 1.14],        // the paint pass's cold blue steel
  rust: -0.25,
  light: 1.02,
  accent: [0.20, 0.55, 1.0],       // the TSF scanner blue
  accentK: 0.85,
  grime: [0.19, 0.21, 0.27],
  grimeK: 0.30,
  cable: [0.15, 0.16, 0.19],
  left: ["ribL"],
  pelvis: [],
  spine: [],
};
export const STYLE_INS = {
  camo: true,                      // flecktarn under the weather
  tint: [0.92, 0.96, 0.80],        // a green cast under the paint
  rust: 0.50,
  light: 0.96,
  accent: [0.62, 0.10, 0.08],      // the lamps and the drum bands stay RED
  accentK: 0.80,
  grime: [0.14, 0.12, 0.07],
  grimeK: 0.50,
  cable: [0.13, 0.12, 0.10],
  left: ["scrap", "can"],
  pelvis: ["cabE"],
  spine: ["wire3"],
};

// ── the picture ────────────────────────────────────────────────────────────
export function paintSheet(ST) {
  const W = K.workshop;
  const S = W.sheet(SIZE, SIZE);
  const Z = W.allot(SIZE, SIZE, {
    HOUS: [18, 15], SKIRT: [14, 14], DRUM: [11, 22], CHUTE: [18, 10],
    BARR: [28, 10, 2], BRAKE: [7, 27], PAUL: [16, 34, 2], PLATE: [16, 14],
    CAN: [12, 11], ANT: [22, 5], CABLE: [25, 7, ST.pelvis.length + 4], WIRE: [18, 3.5, ST.spine.length + 2],
  });

  // flecktarn, the same blob logic the body pass uses: a base green, clusters
  // of dark green and near-black, patches of tan and brown, fine speckle over
  // it. Painted at 0.86 so a little steel shows through as wear.
  const FLEK = {
    base: [0.24, 0.28, 0.15], dark: [0.13, 0.17, 0.085], black: [0.085, 0.095, 0.07],
    tan: [0.40, 0.34, 0.19], brown: [0.27, 0.15, 0.075],
  };
  const camo = (u, v, seed, c) => {
    const s = W.fbm(u / 2.8 + seed, v / 2.8, seed * 3 + 1, 2);
    const f = W.fbm(u / 1.1 + seed * 2, v / 1.1 + 7, seed * 5 + 3, 3);
    let k = FLEK.base;
    if (s > 0.56) k = f > 0.52 ? FLEK.dark : FLEK.black;
    else if (s < 0.40) k = f > 0.55 ? FLEK.tan : FLEK.brown;
    else if (f > 0.68) k = FLEK.dark;
    return W.mix(c, k, 0.86);
  };

  // a riveted, grimy plate -- the base look of every flat piece
  const panel = (z, seed) => S.zone(z, (u, v) => {
    let c = W.steel(u / 6, v / 6, ST.light, seed, ST.rust);
    c = shade(c, ST.tint);
    const m = Math.min(u, v, z.w - u, z.h - v);
    c = W.times(c, 0.72 + 0.28 * clamp(m / 3.5));
    if (ST.camo) c = camo(u, v, seed, c);
    for (const [cx, cy] of [[3, 3], [z.w - 3, 3], [3, z.h - 3], [z.w - 3, z.h - 3]]) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < 2.3) c = W.times(c, d < 1.1 ? 1.24 : 0.66);
    }
    const gr = clamp((W.fbm(u / 6 + seed, v / 26, seed * 5 + 1, 3) - 0.48) * 2.4);
    c = W.mix(c, ST.grime, gr * ST.grimeK);
    return c;
  });

  panel(Z.HOUS, 11);                       // housing and its hump share the zone
  panel(Z.SKIRT, 23);
  panel(Z.PAUL, 37);

  // the drum: turned shading round the ring, two accent hoop bands
  S.zone(Z.DRUM, (u, v) => {
    const around = v / Z.DRUM.h;
    let c = shade(W.steel(u / 5, v / 5, ST.light, 41, ST.rust), ST.tint);
    c = W.times(c, 0.60 + 0.60 * W.cylinderLight(around, 0.5));
    if (ST.camo) c = camo(u, v, 41, c);
    if (u < 2.2 || (u > 4.8 && u < 6.8)) c = W.mix(c, ST.accent, ST.accentK);
    const gr = clamp((W.fbm(u / 5 + 9, v / 30, 31, 3) - 0.5) * 2.2);
    return W.mix(c, ST.grime, gr * ST.grimeK);
  });

  // the feed chute: ribs across it
  S.zone(Z.CHUTE, (u, v) => {
    let c = shade(W.steel(u / 5, v / 5, ST.light * 0.9, 47, ST.rust + 0.1), ST.tint);
    c = W.times(c, 0.62 + 0.5 * W.cylinderLight(v / Z.CHUTE.h, 0.4));
    if (ST.camo) c = camo(u, v, 47, c);
    if (u % 4.2 < 1.5) c = W.times(c, 0.66);
    return c;
  });

  // barrels: steel rounds, dark band at the muzzle end
  S.zone(Z.BARR, (u, v) => {
    let c = shade(W.steel(u / 5, v / 5, ST.light, 53, ST.rust), ST.tint);
    c = W.times(c, 0.64 + 0.55 * W.cylinderLight(v / Z.BARR.h, 0.5));
    if (ST.camo) c = camo(u, v, 53, c);
    if (u > Z.BARR.w - 3) c = W.times(c, 0.55);
    if (u % 11 < 1) c = W.times(c, 0.72);
    return c;
  });

  // the muzzle brake: dark, slotted round, accent rim on the front
  S.zone(Z.BRAKE, (u, v) => {
    let c = shade(W.steel(u / 5, v / 5, ST.light * 0.8, 59, ST.rust + 0.15), ST.tint);
    c = W.times(c, 0.62 + 0.45 * W.cylinderLight(v / Z.BRAKE.h, 0.45));
    if (ST.camo) c = camo(u, v, 59, c);
    if (v % 6.5 < 1.8) c = W.times(c, 0.55);
    if (u > Z.BRAKE.w - 2.2) c = W.mix(c, ST.accent, ST.accentK * 0.8);
    return c;
  });

  // the left-side plate is clean ribbing on msr, a welded bare scrap on ins
  // (the scrap is NOT camo -- it came off something else and never got painted)
  S.zone(Z.PLATE, (u, v) => {
    if (ST.left[0] === "scrap") {
      let c = shade(W.steel(u / 4, v / 4, ST.light, 67, 0.7), ST.tint);
      if (v < 3 && u % 3.4 < 2.2) c = W.times(c, 1.3);            // a weld bead along one edge
      const blot = clamp((W.fbm(u / 7 + 3, v / 7, 71, 3) - 0.52) * 4);
      return W.mix(c, [0.30, 0.16, 0.07], blot * 0.55);
    }
    let c = shade(W.steel(u / 5, v / 5, ST.light, 67, ST.rust), ST.tint);
    c = W.times(c, 0.70 + 0.3 * W.cylinderLight(v / Z.PLATE.h, 0.4));
    if (v % 5.5 < 1.6) c = W.times(c, 0.78);
    return c;
  });

  // the fuel can (ins): camo, cross ribs, cap at one corner
  S.zone(Z.CAN, (u, v) => {
    let c = shade(W.steel(u / 5, v / 5, ST.light * 0.95, 73, 0.45), ST.tint);
    if (ST.camo) c = camo(u, v, 73, c);
    if (Math.abs(v / Z.CAN.h - 0.5) < 0.07 || Math.abs(v / Z.CAN.h - 0.25) < 0.05) c = W.times(c, 0.74);
    const d = Math.hypot(u - Z.CAN.w * 0.82, v - 3.5);
    if (d < 3.2) c = W.times(c, d < 1.6 ? 0.6 : 0.95);
    return W.mix(c, [0.28, 0.15, 0.07], clamp((W.fbm(u / 6 + 5, v / 6, 79, 3) - 0.55) * 4) * 0.5);
  });

  // the antenna: steel with collars -- a rod stays a rod, no camo
  S.zone(Z.ANT, (u, v) => {
    let c = shade(W.steel(u / 3, v / 3, ST.light, 83, ST.rust), ST.tint);
    c = W.times(c, 0.7 + 0.5 * W.cylinderLight(v / Z.ANT.h, 0.5));
    if (u % 7 < 1.4) c = W.times(c, 0.55);
    return c;
  });

  // cables, wires and the hanging straps: rubber, clamp collars, a worn sheen
  const rubber = (z, seed, base) => S.zone(z, (u, v) => {
    let c = W.times(base, 0.70 + 0.55 * W.cylinderLight(v / z.h, 0.5));
    c = W.times(c, 0.90 + 0.22 * W.fbm(u / 4, v / 2, seed, 3));
    if (u % 9 < 0.9) c = W.times(c, 0.55);
    return c;
  });
  rubber(Z.CABLE, 89, ST.cable);
  rubber(Z.WIRE, 97, W.times(ST.cable, 0.82));

  return { S, Z };
}

// ── the geometry ───────────────────────────────────────────────────────────
// Every piece: [name, bone, zone, path, tube options]. Bones are resolved by
// name against the model, so a piece misplaced onto a moved bone throws rather
// than silently hanging in space.
const RIGHT = "Bip01 DX Avambraccio", LEFT = "Bip01 SX Avambraccio";
const PELVIS = "Bip01 Bacino", SPINE = "Bip01 Dorso3";

function build(M, Z, ST) {
  const box = { sides: 4, seam: Math.PI / 4, caps: [true, true] };

  // right arm: the machine-gun kit
  M.tube([[1, -31, 38.5, r4(3.6, 7.5)], [13, -31, 38.5, r4(3.6, 7.5)], [17, -31, 38.5, r4(3.2, 6.6)]], Z.HOUS, { name: "hous", ...box });
  M.tube([[5, -30, 43.5, r4(1.6, 4.4)], [12.5, -30, 43.5, r4(1.6, 4.4)]], Z.HOUS, { name: "hump", ...box });
  M.tube([[2, -41.9, 32, r4(6.2, 1.2)], [12, -41.9, 32, r4(6.2, 1.2)], [15.5, -41.9, 33, r4(4.2, 1.2)]], Z.SKIRT, { name: "skirt", ...box });
  M.tube([[-1, -42.4, 23.5, 3.6], [10, -42.4, 23.5, 3.6]], Z.DRUM, { name: "drum", sides: 8, caps: [true, true] });
  M.tube([[8.5, -42.6, 26.5, 1.5], [14, -40, 31.5, 1.5], [15.5, -36, 36, 1.5]], Z.CHUTE, { name: "chute", sides: 5, caps: [true, false] });
  M.tube([[24, -28.8, 32.8, 1.5], [52, -28.8, 32.8, 1.5]], Z.BARR, { name: "barr1", caps: [false, true] });
  M.tube([[24, -37.8, 27.5, 1.5], [44, -37.8, 27.5, 1.5]], Z.BARR, { name: "barr2", caps: [false, true] });
  M.tube([[44.5, -33.4, 28.4, 4.3], [51, -33.4, 28.4, 4.3]], Z.BRAKE, { name: "brake", sides: 8, caps: [true, true] });
  M.tube([[-1, -41.6, 20.5, 0.85], [-5.6, -40.6, 6.5, 0.25]], Z.CABLE, { name: "cab1", sides: 3, caps: [false, true] });
  M.tube([[-1.5, -44.3, 21.5, 0.7], [-6.4, -43.4, 8.5, 0.25]], Z.CABLE, { name: "cab2", sides: 3, caps: [false, true] });
  M.tube([[-6, -16, 39.2, r4(2.7, 6)], [-6, -24, 38.9, r4(2.7, 6)], [-6.6, -31.5, 38.3, r4(2.3, 5.2)]], Z.PAUL, { name: "pauldR", ...box });
  M.tube([[8, -29, 42.6, 0.45], [-1, -25, 41.6, 0.32]], Z.WIRE, { name: "armwire", sides: 3, caps: [false, true] });
  M.leaf([[[17.2, -30.5, 40.8], [17.9, -31.1, 40.3]], [[17.9, -30.8, 34.8], [18.6, -31.4, 34.3]]], Z.CABLE, { name: "tag3" });
  M.leaf([[[11.4, -43.2, 25.6], [12.2, -43.6, 25.2]], [[11.4, -43.2, 19.8], [12.2, -43.6, 19.2]]], Z.CABLE, { name: "tag2" });

  // left arm: pauldron, antenna, a cable off the shoulder, the style's plate
  M.tube([[-6, 16, 39.2, r4(2.7, 6)], [-6, 24, 38.9, r4(2.7, 6)], [-6.6, 31.5, 38.3, r4(2.3, 5.2)]], Z.PAUL, { name: "pauldL", ...box });
  M.tube([[-11.3, 23, 38.2, 0.62], [-13.6, 24.4, 28.5, 0.28]], Z.CABLE, { name: "cabS", sides: 3, caps: [false, true] });
  M.tube([[-6.5, 27.5, 41, 0.55], [-11.6, 29.6, 58.5, 0.4]], Z.ANT, { name: "ant", sides: 3, caps: [true, false] });
  M.tube([[-11.6, 29.6, 58.2, 1.05], [-11.6, 29.65, 60.4, 1.05]], Z.ANT, { name: "antKnob", sides: 3, caps: [true, true] });
  if (ST.left.includes("ribL")) {
    M.tube([[2, 41.9, 31, r4(5.6, 1.2)], [14, 41.9, 31, r4(5.6, 1.2)]], Z.SKIRT, { name: "ribL", ...box });
  }
  if (ST.left.includes("scrap")) {
    M.tube([[-5, 22, 38.8, r4(0.9, 6.5)], [-5, 30, 37.4, r4(0.9, 5.6)], [-6, 38.5, 35.6, r4(0.9, 4.6)]], Z.PLATE, { name: "scrap", ...box });
  }
  if (ST.left.includes("can")) {
    M.tube([[-7, 40.8, 24.5, r4(3.5, 3)], [-7, 43.4, 24.5, r4(3.0, 2.5)]], Z.CAN, { name: "can", ...box });
  }

  // pelvis: the cables that dangle -- start caps left open, that end is buried
  M.tube([[-7, -4.5, 2.5, 1.05], [-8.4, -5.2, -13, 0.7], [-9, -5.5, -19, 0.3]], Z.CABLE, { name: "cabA", sides: 3, caps: [false, true] });
  M.tube([[-6, -1.5, 2.5, 1.25], [-7.1, -2.1, -15, 0.8], [-7.4, -2.3, -21, 0.3]], Z.CABLE, { name: "cabB", sides: 3, caps: [false, true] });
  M.tube([[-6, 1.5, 2.5, 0.95], [-6.7, 2.4, -10.5, 0.55], [-6.9, 2.7, -15, 0.25]], Z.CABLE, { name: "cabC", sides: 3, caps: [false, true] });
  M.tube([[-7, 4.6, 2.5, 1.1], [-7.9, 5.8, -9, 0.65], [-8.1, 6.2, -13.5, 0.28]], Z.CABLE, { name: "cabD", sides: 3, caps: [false, true] });
  M.leaf([[[10.8, -3.4, 10.4], [11.6, -4.0, 10.0]], [[10.8, -3.4, 4.2], [11.6, -4.0, 3.6]]], Z.CABLE, { name: "tag1" });
  if (ST.pelvis.includes("cabE")) {
    M.tube([[-8.5, 8.5, 2, 1.0], [-10.8, 9.9, -12.5, 0.6], [-11.2, 10.1, -17.5, 0.25]], Z.CABLE, { name: "cabE", sides: 3, caps: [false, true] });
  }

  // the upper back: wires from the dome down
  M.tube([[-22, -6, 41.5, 0.5], [-19.5, -8, 26, 0.4]], Z.WIRE, { name: "wire1", sides: 3, caps: [false, true] });
  M.tube([[-22, 6, 41.5, 0.5], [-19.5, 8, 26, 0.4]], Z.WIRE, { name: "wire2", sides: 3, caps: [false, true] });
  if (ST.spine.includes("wire3")) {
    M.tube([[-20, 0.5, 42.5, 0.75], [-18.5, 1.3, 25.5, 0.55]], Z.WIRE, { name: "wire3", sides: 3, caps: [false, true] });
  }
}

// ── on to the model ────────────────────────────────────────────────────────
// ONE mesh for the whole kit. The norm table is counted per submodel -- 2048
// is the ceiling and the body already spends 1710 -- so separate meshes per
// bone would not fit; a single mesh lets the table dedupe every direction two
// pieces share (all the boxes share the same six). Corners carry their own
// bone, matrix and smoothing angle, which is exactly what meshOf takes.
const HARD = ["hous", "hump", "skirt", "pauldR", "pauldL", "ribL", "scrap", "can"];

const ownerOf = (n, ST) => {
  if (ST.left.some((x) => n.startsWith(x))) return LEFT;
  if (/^(tag2|tag3|armwire)/.test(n)) return RIGHT;
  if (/^tag/.test(n)) return PELVIS;
  if (/^cabS/.test(n)) return LEFT;
  if (/^(hous|hump|skirt|drum|chute|barr|brake|cab1|cab2|pauldR)/.test(n)) return RIGHT;
  if (/^(pauldL|ant)/.test(n)) return LEFT;
  if (/^cab/.test(n)) return PELVIS;
  if (/^wire/.test(n)) return SPINE;
  return null;
};

export function addGear(mdl, ST, only = null) {
  const { S, Z } = paintSheet(ST);
  const M = K.workshop.shape(SIZE, SIZE);
  build(M, Z, ST);
  const tris = only ? M.tris.filter((t) => only.includes(ownerOf(String(t[0].of ?? ""), ST))) : M.tris;

  const tex = K.indexed(S.image(), "mechgear.bmp");
  const names = K.bones(mdl).map((b) => b.name);
  const P = K.poseAt(mdl, POSE.seq, POSE.frame);
  const where = { bodypart: 0, model: 0 };

  const on = {};
  for (const boneName of [RIGHT, LEFT, PELVIS, SPINE]) {
    const bone = names.indexOf(boneName);
    if (bone < 0) throw new Error(`mech gear: no bone named ${boneName}`);
    on[boneName] = { bone, to: K.inverse34(P[bone]) };
  }

  const stamped = tris.map((t) => t.map((c) => {
    const n = String(c.of ?? "");
    const boneName = ownerOf(n, ST);
    if (!boneName) throw new Error(`mech gear: no home for piece "${n}"`);
    const base = n.replace(/\.(cap|lining|rim|back).*$/, "");
    return { ...c, ...on[boneName], smooth: HARD.includes(base) ? 38 : 75 };
  }));

  const at = K.readMdl(mdl).bodyparts[0].models[0].meshes.length;
  const built = K.meshOf(null, stamped, tex, on[RIGHT].bone, 60);
  const out = K.replaceMesh(K.addMesh(mdl, where), { ...where, mesh: at }, built, tex);
  const me = K.readMdl(out).bodyparts[0].models[0];
  const m2 = me.meshes[at];
  console.log(`  gear: ${tris.length} tris on 4 bones, one mesh at ${at} -- submodel now ${me.numverts ?? "?"} verts / ${me.numnorms ?? m2.numnorms ?? "?"} norms`);
  return { mdl: out, texture: tex };
}
