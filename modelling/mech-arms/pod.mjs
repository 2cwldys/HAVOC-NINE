// The Mech's rocket launcher as an arm-mounted weapon: the same armoured gauntlet as the minigun's, ending in a four-tube
// rocket pod (2 x 2 tubes in a revolving cage, a bulkhead ring, a breech housing with a loader hatch). The cage turns a
// quarter at each shot (a square of four tubes is the same picture after a quarter turn), the arm kicks back, the hatch
// opens for the reload. No hand, claw or grip anywhere.
//
// Parts, by the bone they ride on (the first letters of a part's name):
//   m60_    gauntlet, wrist collar, side band, breech housing, bulkhead ring, loader port, pistons, hoses     (bone m60)
//   rotor_  the four tubes, their three plates and hub: turned a quarter by the shoot animations              (bone rotor, added)
//   cover_  the gauntlet's loader hatch: opened by the reload as the M60's cover is                           (bone cover)
//
// build(side, { size, kind }): kind "v" the view model (all of it), "p" the pod as another player sees it on the arm (a short
// gauntlet, no hoses), "w" the pod alone with a cap on its rear.
import { W, pack, gunmetal, edge, bolt, groove, inset, hazard, times, mix, DARK, WORN, AMBER, YELLOW } from "./paint.mjs";
import { SIDES } from "./common.mjs";
import { r8, gauntlet, piston, hose, plate, FACE, roundOf, open8, slabOf } from "./kit.mjs";
import { zones as baseZones, paint as paintShared } from "./minigun.mjs";

const { cylinderLight } = W;

export const AXIS = { y: -4.9, z: -4.7 };
export const D = {
  muzzleX: 17.6,
  housing: { from: 9.0, to: 11.8, up: 2.15, side: 2.4 },
  ring: { from: 11.5, to: 12.4, r: 2.75 },
  tubeFrom: 12.2, tubeR: 1.15, tubeOff: 1.35, plateR: 2.15,
  gauntlet: { cy: AXIS.y, cz: AXIS.z, up: 1.7, side: 2.1, stations: [-8.5, 2.0, 8.2], u: [0, 0.1, 1.0], facePx: [18, 10, 10, 10, 14, 36, 40, 38] },
};
const HOUS_PX = [14, 8, 8, 8, 10, 28, 30, 22];

export const boneOf = (of) => {
  if (of.startsWith("m60_")) return "m60";
  if (of.startsWith("rotor_")) return "rotor";
  if (of.startsWith("cover_")) return "cover";
  return null;
};
const onAxis = (cy = AXIS.y, cz = AXIS.z) => (s, a, b) => [s, cy + a, cz + b];

export function zones(size = 512) {
  return baseZones(size, [["TUBE", 160, 32], ["RING", 96, 40]]);
}

function paintPod(S, Z, rgb) {
  paintShared(S, Z, rgb);
  // the tubes: painted steel, a hazard collar and a red line near the mouth, a seam and bolts
  S.zone(Z.TUBE, (u, v) => {
    const across = v / Z.TUBE.h, along = u / Z.TUBE.w;
    let c = times(gunmetal(u, v, 61, 1.55, [0.24, 0.255, 0.23]), 0.55 + 0.7 * cylinderLight(across, 0.5));
    c = groove(c, (along - 0.3) * Z.TUBE.w, 0.7);
    if (along > 0.66 && along < 0.76) c = hazard(u, v, 6, 1);
    if (along > 0.78 && along < 0.8) c = [0.66, 0.15, 0.12];
    if (along > 0.94) c = times(c, 0.5);
    return c;
  });
  S.zone(Z.RING, (u, v) => {
    let c = gunmetal(u, v, 73, 1.6);
    c = groove(c, v - Z.RING.h * 0.5, 0.6);
    for (let x = 6; x < Z.RING.w; x += 14) { c = bolt(c, u, v, x, Z.RING.h * 0.25, 1.8); c = bolt(c, u, v, x, Z.RING.h * 0.75, 1.8); }
    return mix(c, WORN, 0.3 * edge(u, v, Z.RING, 1.3));
  });
}

export function build(side = "default", { size = 512, kind = "v" } = {}) {
  const rgb = SIDES[side];
  const Z = zones(size);
  const M = W.shape(size, size);
  const S = W.sheet(size, size, [0.12, 0.125, 0.14]);
  paintPod(S, Z, rgb);
  const oct = open8;
  const slab = slabOf(Z);
  const H = D.housing;
  const G = kind === "p" ? { ...D.gauntlet, stations: [-4, 8.2], u: [0, 1] } : D.gauntlet;
  const gy = G.cy, gz = G.cz;
  const rawFore = G.stations.length === 2;

  // -- the bone m60: the arm and the pod's body --
  if (kind !== "w") {
    if (rawFore) {
      const r = r8(G.up, G.side);
      M.tube(G.stations.map((x) => [x, gy, gz, r]), Z.FORE, { name: "m60_fore", ...oct, smooth: 35, places: { rings: [[0, 0.1], [G.stations[1] - G.stations[0], 1]], round: roundOf(G.facePx) } });
    } else gauntlet(M, Z, G);
    M.tube([[8.2, gy, gz, r8(2.0, 2.4)], [9.0, gy, gz, r8(2.0, 2.4)]], Z.COLLAR, { name: "m60_collar", ...oct, smooth: 35 });
    M.tube([[5.6, gy, gz, r8(G.up + 0.2, G.side + 0.2)], [6.6, gy, gz, r8(G.up + 0.2, G.side + 0.2)]], Z.BAND, { name: "m60_band", ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
    if (kind === "v") {
      M.tube([[-8.9, gy, gz, r8(G.up + 0.15, G.side + 0.15)], [-8.4, gy, gz, r8(G.up + 0.15, G.side + 0.15)]], Z.COLLAR, { name: "m60_elbow", ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
      for (const x of [-6, -3.2, -0.6]) M.tube([[x, gy, gz, r8(G.up + 0.12, G.side + 0.12)], [x + 0.5, gy, gz, r8(G.up + 0.12, G.side + 0.12)]], Z.COLLAR, { name: "m60_rib" + x, ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
      plate(M, Z, Z.PLATE, "m60_plate1", 3.8, 5.4, gy + G.side + 0.05, gz - 0.1, 0.62, 0.14);
      plate(M, Z, Z.PLATE, "m60_plate2", 6.8, 8.1, gy + G.side + 0.05, gz - 0.1, 0.62, 0.14);
      hose(M, Z, "m60_hose1", [[9.3, gy + 2.3, gz - 0.4], [7.5, gy + 2.05, gz - 0.95], [4.0, gy + 2.0, gz - 1.05], [1.0, gy + 2.05, gz - 0.9]]);
      hose(M, Z, "m60_hose2", [[9.3, gy + 2.3, gz - 0.05], [7.2, gy + 2.0, gz - 0.6], [3.5, gy + 2.0, gz - 0.75], [1.0, gy + 2.05, gz - 0.6]], 0.17);
    }
    piston(M, Z, "m60_pst", gy + 1.55, gz + 1.5, 1.5, 5.2, 8.0, 0.5);
    for (const x of [2.3, 4.6]) M.turn([[x, 0.62], [x + 0.35, 0.62]], Z.CLAMP, { name: "m60_pclamp" + x, sides: 10, at: onAxis(gy + 1.55, gz + 1.5), caps: [Z.CAPS, Z.CAPS], smooth: 30 });
    M.tube([[7.9, gy + 1.55, gz + 1.5, [0.45, 0.42]], [8.5, gy + 1.55, gz + 1.5, [0.45, 0.42]]], Z.FIT, { name: "m60_pbrk", ...slab, smooth: 30 });
  } else {
    // the pod on its own: a plate closes the breech's rear, two feet under it
    M.tube([[H.from - 0.4, AXIS.y, AXIS.z, r8(H.up, H.side)], [H.from, AXIS.y, AXIS.z, r8(H.up, H.side)]], Z.COLLAR, { name: "m60_rear", ...slab, sides: 8, seam: Math.PI / 8, smooth: 35 });
    for (const x of [9.6, 11.0]) M.tube([[x, AXIS.y, AXIS.z - H.up - 0.35, [0.45, 1.6]], [x + 0.7, AXIS.y, AXIS.z - H.up - 0.35, [0.45, 1.6]]], Z.PLATE, { name: "m60_foot" + x, ...slab, smooth: 30 });
  }
  // the breech housing, the bulkhead ring the cage turns in, the loader port and its four lamps (a rocket each), a sight
  M.tube([[H.from, AXIS.y, AXIS.z, r8(H.up, H.side)], [H.to, AXIS.y, AXIS.z, r8(H.up, H.side)]], Z.HOUS,
    { name: "m60_hous", ...oct, smooth: 35, places: { rings: [[0, 0], [H.to - H.from, 1]], round: roundOf(HOUS_PX) } });
  M.turn([{ s: D.ring.from, r: D.ring.r - 0.15 }, { s: D.ring.from + 0.15, r: D.ring.r, crease: true }, { s: D.ring.to - 0.15, r: D.ring.r, crease: true }, { s: D.ring.to, r: D.ring.r - 0.15, crease: true }],
    Z.RING, { name: "m60_ring", sides: 16, at: onAxis(), seam: Math.PI * 1.5, caps: [Z.CAPS, Z.CAPS], smooth: 35 });
  M.tube([[9.4, AXIS.y + H.side + 0.05, AXIS.z - 0.2, [0.95, 0.12]], [11.4, AXIS.y + H.side + 0.05, AXIS.z - 0.2, [0.95, 0.12]]], Z.FIT, { name: "m60_loader", ...slab, smooth: 30 });
  for (let k = 0; k < 4; k++) M.tube([[9.7 + 0.5 * k, AXIS.y + H.side + 0.1, AXIS.z + 0.55, 0.16], [9.7 + 0.5 * k, AXIS.y + H.side + 0.3, AXIS.z + 0.55, 0.16]], Z.LAMP, { name: "m60_lamp" + k, sides: 6, caps: [Z.CAPS, Z.CAPS] });
  M.tube([[9.6, AXIS.y - 0.4, AXIS.z + H.up + 0.2, [0.22, 0.6]], [11.4, AXIS.y - 0.4, AXIS.z + H.up + 0.2, [0.22, 0.6]]], Z.FIT, { name: "m60_sight", ...slab, smooth: 30 });
  M.tube([[9.4, AXIS.y + 0.9, AXIS.z + H.up + 0.12, [0.12, 0.35]], [11.6, AXIS.y + 0.9, AXIS.z + H.up + 0.12, [0.12, 0.35]]], Z.PLATE, { name: "m60_rail", ...slab, smooth: 30 });

  // -- the bone rotor: the cage of four tubes, three plates and a hub --
  for (let k = 0; k < 4; k++) {
    const a = (Math.PI / 2) * k + Math.PI / 4;
    const cy = AXIS.y + D.tubeOff * Math.sqrt(2) * Math.cos(a), cz = AXIS.z + D.tubeOff * Math.sqrt(2) * Math.sin(a);
    M.turn([[D.tubeFrom, D.tubeR], [D.muzzleX - 0.5, D.tubeR], [D.muzzleX - 0.5, D.tubeR + 0.14], [D.muzzleX, D.tubeR + 0.14]], Z.TUBE,
      { name: "rotor_tube" + k, sides: 12, at: onAxis(cy, cz), caps: [false, Z.CAPS], smooth: 35 });
  }
  M.turn([[D.tubeFrom, 0.8], [D.muzzleX - 0.8, 0.8]], Z.RING, { name: "rotor_hub", sides: 10, at: onAxis(), caps: [false, Z.CAPS] });
  const plateAt = (name, s0, s1, r) =>
    M.turn([{ s: s0, r: r - 0.12 }, { s: s0 + 0.12, r, crease: true }, { s: s1 - 0.12, r, crease: true }, { s: s1, r: r - 0.12, crease: true }], Z.CLAMP,
      { name, sides: 14, at: onAxis(), caps: [Z.DISC, Z.DISC2], smooth: 35 });
  plateAt("rotor_plate1", 12.9, 13.7, D.plateR);
  plateAt("rotor_plate2", 14.7, 15.5, D.plateR);
  plateAt("rotor_plate3", 16.3, 17.1, D.plateR);

  // -- the bone cover: the gauntlet's loader hatch, hinged at its front (x 8.3) --
  if (kind !== "w") {
    M.tube([[3.0, gy, gz + G.up + 0.28, [0.28, 1.0]], [8.2, gy, gz + G.up + 0.28, [0.28, 1.0]]], Z.HATCH,
      { name: "cover_lid", ...slab, smooth: 30, places: { rings: [[0, 0], [5.2, 1]], round: roundOf([6, 8, 6, 52]) } });
    M.tube([[3.6, gy, gz + G.up + 0.62, [0.07, 0.3]], [7.6, gy, gz + G.up + 0.62, [0.07, 0.3]]], Z.PLATE, { name: "cover_rail", ...slab, smooth: 30 });
  }
  return { M, S, Z, tris: M.tris, image: S.image() };
}
