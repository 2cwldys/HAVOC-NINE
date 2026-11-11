// The Mech minigun's ammunition belt and the feed throat it slides into.
//
// The belt is rounds in links on a straight line that leaves the throat's mouth down and outwards, every round a pitch from the next,
// each a brass case lying along the bore with its tip forward. Offsets are from the bore axis (y to the left, z up). Site k is the
// place of the kth round from the first one hanging below the mouth (k = 0); the round of site -1 stands at the mouth and is mostly
// inside the throat. The whole belt is one rigid piece on the bone `belt` (boneOf in minigun.mjs); the shoot animations slide it one
// pitch toward the gun (motion.mjs slide, build-minigun.mjs). Every round is the same, so after the slide the belt looks as it did
// before it: the round that went into the throat is replaced by the next one, and the animation can start again without a jump.
//
// The throat is a closed box (a slab) whose lower face is the mouth (BELT.mouth): what is above the mouth is inside it, behind its walls.
// It is large enough that no round shows through a wall or the roof at any place of the slide; check-belt.mjs measures that (mouth).
//
// `rounds` is how many sites outwards from site 0 a view model carries. The far end must be out of the picture at the widest field of
// view, and still be after the slide moved it a pitch toward the gun and the arm's own motion moved it (the melee thrust brings it
// nearest): check-belt.mjs measures the margin in every frame of every animation, at fov 90, 100, 110 and 120 on 4:3, 5:4, 16:10 and 16:9
// (up to fov 120 the end is out of the picture by a pitch or more in every frame; the melee thrust, which brings the belt nearest, shows
// it from about fov 128 on 5:4 and 130 on 4:3, the fire animation from about fov 138, the idle, draw and reload poses not before that).
// One submodel holds 2048 points in GoldSrc and a round takes 54: 37 rounds is the most one bodypart can carry.
import { slabOf } from "./kit.mjs";

export const BELT = {
  first: [2.75, -1.25],                                    // site 0's middle, y and z about the bore axis
  step: [0.12, -0.55],                                     // from a site to the next one outwards
  pitch: Math.hypot(0.12, 0.55),                           // between two rounds' middles
  toward: [-0.12 / Math.hypot(0.12, 0.55), 0.55 / Math.hypot(0.12, 0.55)],   // the way the belt slides: toward the gun (y, z)
  inner: 1,                                                // sites above site 0 that carry a round at rest (the mouth's)
  rounds: 34,                                              // sites from 0 outwards of a view model's belt
  feedFrames: 3,                                           // frames of a shoot animation the one-pitch slide takes (a shot comes every 3.6)
  mouth: { x: [9.8, 12.9], y: [1.75, 3.05], z: [-0.8, 0.4] },   // the feed throat's box about the bore axis: its lower face is the mouth
};

/** The middle of site k about the bore axis `axis` ({ y, z }), as [y, z]. */
export const siteAt = (axis, k) => [axis.y + BELT.first[0] + BELT.step[0] * k, axis.z + BELT.first[1] + BELT.step[1] * k];

/** Where the belt bone rests: the middle of the mouth, in the model's space. */
export const mouthAt = (axis) => [(BELT.mouth.x[0] + BELT.mouth.x[1]) / 2, axis.y + (BELT.mouth.y[0] + BELT.mouth.y[1]) / 2, axis.z + BELT.mouth.z[0]];

const onAxis = (cy, cz) => (s, a, b) => [s, cy + a, cz + b];

/** The feed throat, a closed box on the housing's left (a slab's half extents are 0.707 of its radii); it rides on the bone m60. */
export function addThroat(M, Z, axis) {
  const B = BELT.mouth, k45 = Math.SQRT1_2;
  const cy = axis.y + (B.y[0] + B.y[1]) / 2, cz = axis.z + (B.z[0] + B.z[1]) / 2;
  const r = [(B.z[1] - B.z[0]) / 2 / k45, (B.y[1] - B.y[0]) / 2 / k45];
  M.tube([[B.x[0], cy, cz, r], [B.x[1], cy, cz, r]], Z.FIT, { name: "m60_throat", ...slabOf(Z), smooth: 30 });
}

/** The belt's rounds from site -inner to site rounds - 1: a closed brass case, a closed copper tip and a closed link tab each, on the bone belt. */
export function addBelt(M, Z, axis, rounds = BELT.rounds) {
  const slab = slabOf(Z);
  for (let k = -BELT.inner; k < rounds; k++) {
    const n = k + BELT.inner + 1;
    const [cy, cz] = siteAt(axis, k);
    M.turn([[9.9, 0.32], [11.9, 0.32], [12.05, 0.24]], Z.BRASS, { name: "belt" + n + "_case", sides: 8, at: onAxis(cy, cz), caps: [Z.CAPS, Z.CAPS], smooth: 40 });
    M.turn([[12.0, 0.24], [12.7, 0.07]], Z.TIP, { name: "belt" + n + "_tip", sides: 8, at: onAxis(cy, cz), caps: [Z.CAPS, Z.CAPS], smooth: 40 });
    M.tube([[10.0, cy, cz - 0.3, [0.07, 0.3]], [10.9, cy, cz - 0.3, [0.07, 0.3]]], Z.CABLE, { name: "belt" + n + "_link", ...slab, smooth: 30 });
  }
}

/**
 * The belt of the cannon lying on the floor (z `floor`, absolute): from the throat's mouth it hangs the way it does in the view, a round a pitch from the next,
 * until a round would sink into the floor; from there it lies along it, a pitch apart, away from the gun. Sites -inner to rounds - 1, as addBelt numbers them.
 */
export function addFloorBelt(M, Z, axis, floor, rounds = 12) {
  const slab = slabOf(Z);
  let lastY = null;
  for (let k = -BELT.inner; k < rounds; k++) {
    const n = k + BELT.inner + 1;
    let [cy, cz] = siteAt(axis, k);
    const lowest = floor + 0.32 + 0.06;                                   // the round's middle on the floor, its link tab just above it
    if (cz < lowest) { cz = lowest; if (lastY !== null && lastY.onFloor) cy = lastY.y + BELT.pitch; lastY = { y: cy, onFloor: true }; }
    else lastY = { y: cy, onFloor: false };
    M.turn([[9.9, 0.32], [11.9, 0.32], [12.05, 0.24]], Z.BRASS, { name: "belt" + n + "_case", sides: 8, at: onAxis(cy, cz), caps: [Z.CAPS, Z.CAPS], smooth: 40 });
    M.turn([[12.0, 0.24], [12.7, 0.07]], Z.TIP, { name: "belt" + n + "_tip", sides: 8, at: onAxis(cy, cz), caps: [Z.CAPS, Z.CAPS], smooth: 40 });
    M.tube([[10.0, cy, cz - 0.3, [0.07, 0.3]], [10.9, cy, cz - 0.3, [0.07, 0.3]]], Z.CABLE, { name: "belt" + n + "_link", ...slab, smooth: 30 });
  }
}
