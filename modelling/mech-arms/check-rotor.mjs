// A check that the rotor bone turns about the bore: seen from the m60 bone it hangs on, the centroid of everything on the
// rotor bone stays put at every frame of the shoot animations while its farthest point goes round.
//   node check-rotor.mjs <model.mdl>
import { readFileSync } from "node:fs";
import { K } from "./common.mjs";

const file = process.argv[2];
const src = readFileSync(file);
const names = K.readMdl(src).bones;
const rotor = names.indexOf("rotor"), m60 = names.indexOf("m60");
for (const seq of ["shoot", "shoot2"]) {
  const n = K.sequences(src).find((s) => s.name === seq).frames;
  let worst = 0, first = null, moved = 0, mid0 = null;
  for (let f = 0; f < n; f += 3) {
    const P = K.posed(src, { seq: K.sequenceAt(src, seq), frame: f });
    const inv = K.inverse34(P.pose[m60]);
    const pts = P.tris.flatMap((t) => t.c).filter((c) => c.bone === rotor).map((c) => K.apply34(inv, c.p));
    const mid = [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
    mid0 ??= mid;
    worst = Math.max(worst, Math.hypot(mid[0] - mid0[0], mid[1] - mid0[1], mid[2] - mid0[2]));
    const far = pts.reduce((best, p) => (Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]) > Math.hypot(best[0] - mid[0], best[1] - mid[1], best[2] - mid[2]) ? p : best), pts[0]);
    first ??= far;
    moved = Math.max(moved, Math.hypot(far[0] - first[0], far[1] - first[1], far[2] - first[2]));
  }
  console.log(`${seq}: centroid of the rotor's points (in the m60 bone's space) moves by at most ${worst.toFixed(3)}; its farthest point travelled ${moved.toFixed(2)}`);
}
