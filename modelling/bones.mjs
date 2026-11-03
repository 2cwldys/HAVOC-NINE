import { K, load, POSE } from "./lib.mjs";
const m = load("merc"), bs = K.bones(m), P = K.poseAt(m, POSE.seq, POSE.frame);
bs.forEach((b, i) => {
  const t = [P[i][0][3], P[i][1][3], P[i][2][3]];
  console.log(`  ${String(i).padStart(2)}  ${b.name.padEnd(24)} parent ${String(b.parent).padStart(3)}   x ${t[0].toFixed(1).padStart(6)}  y ${t[1].toFixed(1).padStart(6)}  z ${t[2].toFixed(1).padStart(6)}`);
});
