// Motion changes the Mech's arm models make to the M60's animations. Frame counts, rates and events are never touched.
import { K, boneIndex, poses } from "./common.mjs";

/**
 * The melee animation ("stock"): the M60's flips the rifle round and strikes with the butt, which on a gun built into an
 * arm would turn the arm end over end. Here the gun arm keeps its idle attitude and takes the M60's path, shortened: a punch
 * straight ahead and back. The arm's own bones stand still, and m60 is moved by the stock's path of the m60 bone in the
 * world, taken into its parent's space.
 */
export function meleeThrust(stock) {
  const seq = stock.seqs.find((s) => s.name === "stock");
  const m60 = boneIndex(stock, "m60"), hand = boneIndex(stock, "Bone24"), elbow = boneIndex(stock, "Bone23");
  const { idle } = poses(stock);
  const rotHand = [0, 1, 2].map((r) => [0, 1, 2].map((c) => idle[hand][r][c]));
  const inHand = (d) => [0, 1, 2].map((c) => rotHand[0][c] * d[0] + rotHand[1][c] * d[1] + rotHand[2][c] * d[2]);   // transpose: world -> the hand's axes
  const idleValues = stock.seqs[0].frames[0];
  seq.frames = seq.frames.map((frame) => {
    const world = K.boneMatrices(stock.bones, frame);
    // the M60's path, kept low and to the right: out ahead mostly, a little up and to the left, so that the arm's
    // armour does not sweep across the middle of the view
    const d = [0, 1, 2].map((k) => (world[m60][k][3] - idle[m60][k][3]) * [0.45, 0.25, 0.25][k]);
    const next = frame.map((v) => [...v]);
    next[0] = [...idleValues[0]];
    next[elbow] = [...idleValues[elbow]];
    next[hand] = [...idleValues[hand]];
    const base = idleValues[m60];
    const local = inHand(d);
    next[m60] = [base[0] + local[0], base[1] + local[1], base[2] + local[2], base[3], base[4], base[5]];
    return next;
  });
}

/**
 * Recoil of a heavy weapon: the gun arm kicks back along its axis (the world's -x, the hand's local y) as the shot goes,
 * `amount` units, and settles in about half a second. The M60's own small motion stays under it.
 */
export function kick(stock, names, amount) {
  const m60 = boneIndex(stock, "m60");
  const profile = (f) => (f <= 0 ? 0 : f < 3 ? f / 3 : Math.exp(-(f - 3) / 6));
  for (const name of names) {
    const seq = stock.seqs.find((s) => s.name === name);
    seq.frames.forEach((frame, f) => { frame[m60][1] += amount * profile(f); });
  }
}
