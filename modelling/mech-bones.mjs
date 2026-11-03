// Scratch: the mech's bones, where each stands in the rest pose, and which
// bone the cannon/shoulder geometry hangs on -- gear has to bind to the same
// bone as the thing it wraps or it tears off in animation.
import { K, load, POSE } from "./lib.mjs";

const m = load("ed209_ts");
const bones = K.bones(m);
const names = bones.map((b) => b.name);
console.log(`bones: ${names.length}`);

const P = K.poseAt(m, POSE.seq, POSE.frame);
console.log("first bone object:", JSON.stringify(bones[0]).slice(0, 200));
console.log("first pose matrix:", JSON.stringify(P[0]).slice(0, 300));

for (let i = 0; i < names.length; i++) {
  const M = P[i];
  const col = [M[0][3], M[1][3], M[2][3]].map((v) => (v ?? 0).toFixed(1));
  console.log(`${String(i).padStart(2)} ${names[i].padEnd(30)} at ${col.join(", ")}`);
}

const md = K.readMdl(m);
console.log("\nbodyparts:");
md.bodyparts.forEach((bp, i) => {
  console.log(`  ${i}: ${bp.models.length} models`);
  bp.models.forEach((mo, j) => {
    const meshes = (mo.meshes ?? []).map((me) => `${me.numverts}v/${me.numnorms}n/${me.numtris}t`).join("  ");
    console.log(`     model ${j} "${mo.name}" meshes ${mo.meshes?.length}: ${meshes}`);
  });
});

console.log("\npieces:");
try {
  const pcs = K.pieces(m, POSE);
  console.log(`  type ${Array.isArray(pcs) ? "array" : typeof pcs}`);
  const arr = Array.isArray(pcs) ? pcs : pcs?.pieces ?? [];
  console.log(`  count ${arr.length}`);
  console.log("  first:", JSON.stringify(arr[0])?.slice(0, 400));
  const per = {};
  for (const pc of arr) {
    const b = pc.bone ?? pc.boneIndex ?? "?";
    per[b] = per[b] ?? { n: 0, lo: [1e9, 1e9, 1e9], hi: [-1e9, -1e9, -1e9] };
    const s = per[b];
    s.n++;
    const pts = pc.tris ? pc.tris.flatMap((t) => t.map((c) => c.p)) : pc.points ?? [];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      s.lo[k] = Math.min(s.lo[k], p[k]);
      s.hi[k] = Math.max(s.hi[k], p[k]);
    }
  }
  for (const [b, s] of Object.entries(per)) {
    const nm = names[Number(b)] ?? b;
    console.log(`  bone ${String(b).padStart(2)} ${String(nm).padEnd(30)} pieces ${String(s.n).padStart(3)}  x ${s.lo[0].toFixed(1)}..${s.hi[0].toFixed(1)}  y ${s.lo[1].toFixed(1)}..${s.hi[1].toFixed(1)}  z ${s.lo[2].toFixed(1)}..${s.hi[2].toFixed(1)}`);
  }
} catch (e) {
  console.log("  pieces() said:", String(e).slice(0, 200));
}
