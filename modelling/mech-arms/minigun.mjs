// The Mech's minigun as an arm-mounted weapon: an armoured gauntlet (the forearm) with a six-barrel rotary cannon built into
// its end, a belt of brass rounds hanging from the feed throat, hydraulics and hoses. No hand, claw or grip anywhere: the
// cannon is part of the arm.
//
// Parts, by the bone they ride on (the first letters of a part's name):
//   m60_    the gauntlet, wrist collar, side band, gearbox housing, shroud, throat, pistons, hoses, plates   (bone m60)
//   rotor_  six barrels, their core and three clamps: turned by the shoot animations                        (bone rotor, added)
//   cover_  the gauntlet's service hatch: opened by the reload as the M60's cover is                        (bone cover)
//   beltN_  the Nth brass round of the feed belt, from the throat outwards (belt.mjs): the belt slides a      (bone belt, added)
//           pitch into the throat at every shot (the shoot animations); it is long enough to end off the picture
//
// Every part is a closed surface, so that a ray from outside meets a front face first from any side: a tube is capped at both
// ends wherever it is not part of something else. check-solid.mjs counts the open edges and the pixels that look into the model.
//
// build(side, { kind, size, rounds }): kind "v" the view model (all of it, 512 square picture); kind "w" the cannon alone, as it lies on
// the floor: no arm, a hazard-striped flange at its rear, three pads under it, the belt lying on the floor from the throat, and a 256
// square picture. WORLD says how the build script (build-minigun.mjs) places it in w_mechminigun.mdl.
import { W, pack, gunmetal, edge, bolt, groove, inset, hazard, brass, times, mix, accent, DARK, WORN, AMBER } from "./paint.mjs";
import { SIDES } from "./common.mjs";
import { r8, gauntlet, piston, hose, plate, paintFore, FACE, roundOf, faceSpan, open8, slabOf } from "./kit.mjs";
import { BELT, addThroat, addBelt, addFloorBelt } from "./belt.mjs";

const { noise, cylinderLight } = W;

/** The bore axis of the cannon, and the numbers its shapes are made from. */
export const AXIS = { y: -4.8, z: -4.6 };
export const D = {
  muzzleX: 19.8,
  barrelFrom: 12.8, ring: 1.5, barrelR: 0.55, clampR: 1.85,
  housing: { from: 9.0, to: 13.0, up: 1.95, side: 2.15 },
  gauntlet: { cy: AXIS.y, cz: AXIS.z, up: 1.7, side: 2.1, stations: [-8.5, 2.0, 8.2], u: [0, 0.1, 1.0], facePx: [18, 10, 10, 10, 14, 36, 40, 38] },
};
const HOUS_PX = [14, 8, 8, 8, 10, 28, 30, 22];

/**
 * The cannon on the floor. It is drawn in the view model's space like the rest and then placed: scale times its size, its length along
 * the world model's +y (the muzzle forward) centred on x `centreX`, its left (+y in the view) on the model's -x, and the bottom of its
 * pads (z `floor`) on the model's z = 0, the floor a dropped gun's origin rests on.
 */
export const WORLD = {
  scale: 3.0,
  centreX: 14.0,
  floor: AXIS.z - 2.6,
  rounds: 10,                                            // belt sites from the first one hanging below the throat; the belt lies on the floor beyond the third
  pads: [                                                // [x from, x to, half width] of the three pads under the housing and the middle clamp
    [9.5, 10.7, 1.2], [11.9, 13.0, 1.2], [16.7, 18.0, 0.9],
  ],
  padTop: AXIS.z - 1.75,                                 // inside the housing and the clamp, so that a pad is part of them to the eye
};

export const boneOf = (of) => {
  if (of.startsWith("m60_")) return "m60";
  if (of.startsWith("rotor_")) return "rotor";
  if (of.startsWith("cover_")) return "cover";
  if (of.startsWith("belt")) return "belt";
  return null;
};

const onAxis = (cy = AXIS.y, cz = AXIS.z) => (s, a, b) => [s, cy + a, cz + b];

export const ZONE_LIST = [
  ["FORE", 160, 176], ["HOUS", 128, 128], ["CLAMP", 36, 180], ["DISC", 64, 64], ["DISC2", 64, 64],
  ["SHROUD", 64, 112], ["HATCH", 128, 72], ["PLATE", 96, 64], ["COLLAR", 96, 48], ["BAND", 24, 160],
  ["BARREL", 168, 28], ["CORE", 128, 14], ["FIT", 120, 48],
  ["CABLE", 96, 16], ["PISTON", 100, 24], ["ROD", 80, 12], ["BRASS", 64, 20], ["TIP", 32, 12], ["LAMP", 16, 16], ["CAPS", 24, 24],
];
/** The zones of a picture `size` square (the shapes were laid out for 512; a smaller picture scales them all). */
export function zones(size = 512, extra = []) {
  const k = size / 512;
  return pack(size, [...ZONE_LIST, ...extra].map(([n, w, h]) => [n, Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k))]), Math.max(2, Math.round(8 * k)));
}

export function paint(S, Z, rgb) {
  paintFore(S, Z, D.gauntlet);
  const hp = HOUS_PX.map((p) => (p * Z.HOUS.h) / 128);
  // the gearbox housing: panels, a vent bank on the belt's side, the stencil bar along its top
  S.zone(Z.HOUS, (u, v) => {
    let c = gunmetal(u, v, 11, 1.3);
    let acc = 0, k = 7;
    for (let q = 0; q < 8; q++) { if (v < acc + hp[q]) { k = q; break; } acc += hp[q]; }
    const vin = v - acc;
    for (let q = 0, a = 0; q < 8; q++) { c = groove(c, v - a, 0.6); a += hp[q]; }
    for (const x of [0.38, 0.74]) c = groove(c, u - x * Z.HOUS.w, 0.8);
    if (k === FACE.left) for (let j = 0; j < 4; j++) c = inset(c, u, v, 0.55 * Z.HOUS.w, acc + 4 + j * 5.2, 44, 2.4, times(DARK, 1.1));
    if (k === FACE.top && Math.abs(vin - hp[7] / 2) < 2.2 && u > 0.5 * Z.HOUS.w) c = times(c, 0.55);
    if (k === FACE.topLeft && u > 0.08 * Z.HOUS.w && u < 0.3 * Z.HOUS.w && Math.abs(vin - hp[6] / 2) < 2) c = [0.74, 0.58, 0.12];
    for (const kk of [FACE.left, FACE.top, FACE.topLeft]) for (let x = 12; x < Z.HOUS.w - 6; x += 22) {
      const [va] = faceSpan(hp, kk);
      c = bolt(c, u, v, x, va + 3.5, 1.5);
      c = bolt(c, u, v, x, va + hp[kk] - 3.5, 1.5);
    }
    return mix(c, WORN, 0.26 * edge(u, v, Z.HOUS, 1.3));
  });
  S.zone(Z.COLLAR, (u, v) => {
    let c = gunmetal(u, v, 19, 1.4);
    c = groove(c, u - Z.COLLAR.w * 0.5, 0.7);
    for (let x = 6; x < Z.COLLAR.w; x += 12) { c = bolt(c, u, v, x, 10, 1.8); c = bolt(c, u, v, x, Z.COLLAR.h - 10, 1.8); }
    return mix(c, WORN, 0.3 * edge(u, v, Z.COLLAR, 1.3));
  });
  // the shroud: a rear collar, a front lip, vent slots in rows round it
  S.zone(Z.SHROUD, (u, v) => {
    let c = gunmetal(u, v, 23, 1.3);
    for (const x of [0.12, 0.86]) c = groove(c, u - x * Z.SHROUD.w, 0.8);
    for (let r = 0; r < 7; r++) c = inset(c, u, v, 0.48 * Z.SHROUD.w, (r + 0.5) * (Z.SHROUD.h / 7), 22, 5.2, times(DARK, 1.1));
    if (u > Z.SHROUD.w * 0.9) c = mix(c, [0.3, 0.21, 0.17], 0.4);
    return mix(c, WORN, 0.25 * edge(u, v, Z.SHROUD, 1.3));
  });
  // the barrels: blued steel, a bright strip along each, a dark band at the muzzle end
  S.zone(Z.BARREL, (u, v) => {
    const around = v / Z.BARREL.h, along = u / Z.BARREL.w;
    let c = times([0.27, 0.29, 0.34], (0.55 + 0.8 * cylinderLight(around, 0.6)) * (0.96 + 0.08 * noise(u * 0.3, v * 0.3, 31)));
    if (noise(u * 0.25, v * 12, 41) > 0.92) c = mix(c, WORN, 0.28);
    if (along > 0.955) c = times(c, 0.4);
    for (const x of [0.3, 0.62]) c = groove(c, (along - x) * Z.BARREL.w, 0.7);
    return c;
  });
  S.zone(Z.CORE, (u, v) => times([0.26, 0.28, 0.31], 0.75 + 0.45 * cylinderLight(v / Z.CORE.h, 0.5)));
  // the service hatch: a small hazard mark, hinge line, bolts. The top face is the lower part of the zone
  S.zone(Z.HATCH, (u, v) => {
    let c = gunmetal(u, v, 51, 1.35);
    if (v >= 20) {
      const vt = v - 20;
      c = groove(c, u - Z.HATCH.w * 0.94, 0.7);
      if (u > Z.HATCH.w * 0.8 && u < Z.HATCH.w * 0.9 && vt > 10 && vt < 42) c = hazard(u, vt, 6, 1);
      for (const [x, y] of [[8, 8], [8, 44], [Z.HATCH.w - 8, 8], [Z.HATCH.w - 8, 44]]) c = bolt(c, u, vt, x, y, 2.2);
      c = inset(c, u, v, Z.HATCH.w * 0.34, 20 + 26, 40, 6, times(DARK, 1.2));
    }
    return mix(c, WORN, 0.3 * edge(u, v, Z.HATCH, 1.4));
  });
  S.zone(Z.FIT, (u, v) => {
    let c = gunmetal(u, v, 91, 1.2);
    if (Math.floor(u / 7) % 3 === 0 && v > 8 && v < Z.FIT.h - 8) c = times(c, 0.6);
    return mix(c, WORN, 0.25 * edge(u, v, Z.FIT, 1.2));
  });
  S.zone(Z.PLATE, (u, v) => {
    let c = gunmetal(u, v, 97, 1.45);
    c = groove(c, v - Z.PLATE.h * 0.5, 0.6);
    for (const [x, y] of [[8, 8], [Z.PLATE.w - 8, 8], [8, Z.PLATE.h - 8], [Z.PLATE.w - 8, Z.PLATE.h - 8]]) c = bolt(c, u, v, x, y, 2.4);
    return mix(c, WORN, 0.3 * edge(u, v, Z.PLATE, 1.4));
  });
  S.zone(Z.CABLE, (u, v) => times([0.07, 0.075, 0.085], 0.8 + 0.5 * cylinderLight(v / Z.CABLE.h, 0.5) + 0.12 * (Math.floor(u / 8) % 2)));
  S.zone(Z.PISTON, (u, v) => {
    let c = gunmetal(u, v, 33, 1.1);
    c = times(c, 0.7 + 0.5 * cylinderLight(v / Z.PISTON.h, 0.5));
    for (const x of [0.12, 0.88]) c = groove(c, u - x * Z.PISTON.w, 0.8);
    return c;
  });
  S.zone(Z.ROD, (u, v) => times([0.6, 0.62, 0.66], 0.55 + 0.7 * cylinderLight(v / Z.ROD.h, 0.55)));
  S.zone(Z.CLAMP, (u, v) => {
    let c = gunmetal(u, v, 71, 1.6);
    for (let k = 0; k < 16; k++) c = bolt(c, u, v, Z.CLAMP.w / 2, (k + 0.5) * (Z.CLAMP.h / 16), 2.2);
    return mix(c, WORN, 0.3 * edge(u, v, Z.CLAMP, 1.5));
  });
  for (const [name, seed] of [["DISC", 81], ["DISC2", 83]]) {
    S.zone(Z[name], (u, v) => {
      const z = Z[name];
      const r = Math.hypot(u - z.w / 2, v - z.h / 2) / (z.w / 2);
      let c = gunmetal(u, v, seed, 1.5);
      if (r > 0.88) c = times(c, 0.6);
      if (Math.abs(r - 0.55) < 0.025) c = times(c, 0.5);
      return c;
    });
  }
  S.zone(Z.BRASS, (u, v) => brass(u, v, Z.BRASS));
  S.zone(Z.TIP, (u, v) => times([0.62, 0.34, 0.2], 0.6 + 0.7 * cylinderLight(v / Z.TIP.h, 0.5)));
  S.zone(Z.BAND, (u, v) => accent(u, v, Z.BAND.w, rgb), 1);
  S.zone(Z.LAMP, () => AMBER);
  S.zone(Z.CAPS, (u, v) => gunmetal(u, v, 5, 1.0));
}

export function build(side = "default", { rounds = BELT.rounds, kind = "v", size = 512 } = {}) {
  const rgb = SIDES[side];
  const Z = zones(size);
  const M = W.shape(size, size);
  const S = W.sheet(size, size, [0.12, 0.125, 0.14]);
  paint(S, Z, rgb);
  const oct = { ...open8, caps: [Z.CAPS, Z.CAPS] };     // an octagon tube closed at both ends
  const slab = slabOf(Z);
  const H = D.housing, G = D.gauntlet;
  const gy = G.cy, gz = G.cz;

  // -- the bone m60: the arm and the cannon's body --
  if (kind === "v") {
    gauntlet(M, Z, G, [Z.CAPS, Z.CAPS]);
    // a bolted flange closing the arm's rear end (never in view in play) and three ribs along it
    M.tube([[-8.9, gy, gz, r8(G.up + 0.15, G.side + 0.15)], [-8.4, gy, gz, r8(G.up + 0.15, G.side + 0.15)]], Z.COLLAR, { name: "m60_elbow", ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
    for (const x of [-6, -3.2, -0.6]) M.tube([[x, gy, gz, r8(G.up + 0.12, G.side + 0.12)], [x + 0.5, gy, gz, r8(G.up + 0.12, G.side + 0.12)]], Z.COLLAR, { name: "m60_rib" + x, ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
  }
  // the wrist: a step ring where the arm meets the housing (on the cannon alone it is the hazard-striped flange at its rear), the side's
  // band round the forearm, two armour plates beside it
  M.tube([[8.2, gy, gz, r8(2.0, 2.4)], [9.0, gy, gz, r8(2.0, 2.4)]], kind === "w" ? Z.BAND : Z.COLLAR, { name: "m60_collar", ...oct, smooth: 35 });
  if (kind === "v") {
    M.tube([[5.6, gy, gz, r8(G.up + 0.2, G.side + 0.2)], [6.6, gy, gz, r8(G.up + 0.2, G.side + 0.2)]], Z.BAND, { name: "m60_band", ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
    plate(M, Z, Z.PLATE, "m60_plate1", 3.8, 5.4, gy + G.side + 0.05, gz - 0.1, 0.62, 0.14);
    plate(M, Z, Z.PLATE, "m60_plate2", 6.8, 8.1, gy + G.side + 0.05, gz - 0.1, 0.62, 0.14);
    // hydraulics: a piston on the shoulder of the arm into a bracket at the wrist, two hoses along the flank
    piston(M, Z, "m60_pst", gy + 1.55, gz + 1.5, 1.5, 5.2, 8.0, 0.5, true);
    for (const x of [2.3, 4.6]) M.turn([[x, 0.62], [x + 0.35, 0.62]], Z.CLAMP, { name: "m60_pclamp" + x, sides: 10, at: onAxis(gy + 1.55, gz + 1.5), caps: [Z.CAPS, Z.CAPS], smooth: 30 });
    M.tube([[7.9, gy + 1.55, gz + 1.5, [0.45, 0.42]], [8.5, gy + 1.55, gz + 1.5, [0.45, 0.42]]], Z.FIT, { name: "m60_pbrk", ...slab, smooth: 30 });
    hose(M, Z, "m60_hose1", [[9.3, gy + 2.3, gz - 0.4], [7.5, gy + 2.05, gz - 0.95], [4.0, gy + 2.0, gz - 1.05], [1.0, gy + 2.05, gz - 0.9]]);
    hose(M, Z, "m60_hose2", [[9.3, gy + 2.3, gz - 0.05], [7.2, gy + 2.0, gz - 0.6], [3.5, gy + 2.0, gz - 0.75], [1.0, gy + 2.05, gz - 0.6]], 0.17);
  }
  // the gearbox housing, the shroud over the rotor's root, the feed throat
  M.tube([[H.from, AXIS.y, AXIS.z, r8(H.up, H.side)], [H.to, AXIS.y, AXIS.z, r8(H.up, H.side)]], Z.HOUS,
    { name: "m60_hous", ...oct, smooth: 35, places: { rings: [[0, 0], [H.to - H.from, 1]], round: roundOf(HOUS_PX) } });
  M.turn(
    [{ s: H.to - 0.1, r: 2.12 }, { s: H.to + 0.1, r: 2.15, crease: true }, { s: H.to + 1.1, r: 2.15, crease: true }, { s: H.to + 1.3, r: 1.9, crease: true }],
    Z.SHROUD, { name: "m60_shroud", sides: 14, at: onAxis(), seam: Math.PI * 1.5, caps: [Z.CAPS, Z.DISC], smooth: 35 });
  addThroat(M, Z, AXIS);   // a box on the housing's left whose lower face is the mouth the belt slides into
  M.tube([[9.4, AXIS.y + 2.1, AXIS.z + 0.7, 0.16], [9.4, AXIS.y + 2.32, AXIS.z + 0.7, 0.16]], Z.LAMP, { name: "m60_lamp", sides: 6, caps: [Z.CAPS, Z.CAPS] });
  // a rail on the housing's top
  M.tube([[9.6, AXIS.y, AXIS.z + H.up + 0.12, [0.14, 0.55]], [12.5, AXIS.y, AXIS.z + H.up + 0.12, [0.14, 0.55]]], Z.PLATE, { name: "m60_rail", ...slab, smooth: 30 });
  if (kind === "w") {
    // the cannon on the floor stands on three pads: two under the housing, one under the middle clamp
    const mid = (WORLD.floor + WORLD.padTop) / 2, half = (WORLD.padTop - WORLD.floor) / 2;
    WORLD.pads.forEach(([x0, x1, side], i) => {
      const r = [half / Math.SQRT1_2, side / Math.SQRT1_2];
      M.tube([[x0, AXIS.y, mid, r], [x1, AXIS.y, mid, r]], Z.PLATE, { name: "m60_pad" + i, ...slab, smooth: 30 });
    });
  }

  // -- the bone rotor: six barrels, a core and three clamps --
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    const cy = AXIS.y + D.ring * Math.cos(a), cz = AXIS.z + D.ring * Math.sin(a);
    M.turn([[D.barrelFrom, D.barrelR], [D.muzzleX - 0.25, D.barrelR], [D.muzzleX, D.barrelR - 0.08]], Z.BARREL,
      { name: "rotor_barrel" + k, sides: 8, at: onAxis(cy, cz), caps: [Z.CAPS, Z.CAPS], smooth: 40 });
  }
  M.turn([[D.barrelFrom, 0.7], [D.muzzleX - 1.0, 0.7]], Z.CORE, { name: "rotor_core", sides: 8, at: onAxis(), caps: [Z.CAPS, Z.CAPS] });
  const clamp = (name, s0, s1, r, disc) =>
    M.turn([{ s: s0, r: r - 0.14 }, { s: s0 + 0.14, r, crease: true }, { s: s1 - 0.14, r, crease: true }, { s: s1, r: r - 0.14, crease: true }], Z.CLAMP,
      { name, sides: 12, at: onAxis(), caps: [disc, disc], smooth: 35 });
  clamp("rotor_clamp_hub", 14.6, 15.5, D.clampR, Z.DISC);
  clamp("rotor_clamp_mid", 16.9, 17.8, D.clampR, Z.DISC2);
  clamp("rotor_clamp_front", D.muzzleX - 0.95, D.muzzleX, D.clampR + 0.06, Z.DISC);

  // -- the bone cover: the gauntlet's service hatch, hinged at its front (x 8.3) --
  if (kind === "v") {
    M.tube([[3.0, gy, gz + G.up + 0.28, [0.28, 1.0]], [8.2, gy, gz + G.up + 0.28, [0.28, 1.0]]], Z.HATCH,
      { name: "cover_lid", ...slab, smooth: 30, places: { rings: [[0, 0], [5.2, 1]], round: roundOf([6, 8, 6, 52]) } });
    M.tube([[3.6, gy, gz + G.up + 0.62, [0.07, 0.3]], [7.6, gy, gz + G.up + 0.62, [0.07, 0.3]]], Z.PLATE, { name: "cover_rail", ...slab, smooth: 30 });
  }

  // -- the bone belt: the ammunition belt, from the throat's mouth out past the edge of the picture (belt.mjs); on the floor it lies there --
  if (kind === "w") addFloorBelt(M, Z, AXIS, WORLD.floor, WORLD.rounds);
  else addBelt(M, Z, AXIS, rounds);
  return { M, S, Z, tris: M.tris, image: S.image() };
}
