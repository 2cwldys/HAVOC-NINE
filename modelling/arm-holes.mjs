// Where a model is open: edges that belong to only ONE triangle.
//
//     node arm-holes.mjs [model]
//
// A closed surface shares every edge between exactly two triangles. An edge with one is a
// boundary -- the rim of a hole -- and that is what you see through. This finds them without
// anyone having to squint at a render, and says which bone they sit on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { K, IN } from "./lib.mjs";

const name = process.argv[2] ?? "repuheavy_fem";
const mdl = readFileSync(join(IN, name, `${name}.mdl`));
const md = K.readMdl(mdl);
const P = K.poseAt(mdl, 1, 0);
const names = K.bones(mdl).map((b) => b.name);

const edges = new Map();           // "a|b" -> { n, bones:Set, at }
const key = (p) => p.map((v) => Math.round(v * 16)).join(",");

for (const bp of md.bodyparts) for (const mo of bp.models) for (const me of mo.meshes) {
  for (const t of K.readMesh(mdl, mo, me)) {
    const w = t.map((c) => K.apply34(P[c.bone], c.p));
    for (let i = 0; i < 3; i++) {
      const a = key(w[i]), b = key(w[(i + 1) % 3]);
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const e = edges.get(k) ?? { n: 0, bones: new Set(), at: w[i] };
      e.n++;
      e.bones.add(t[i].bone);
      edges.set(k, e);
    }
  }
}

const open = [...edges.values()].filter((e) => e.n === 1);
console.log(`\n  ${name}: ${edges.size} edges, ${open.length} of them open\n`);

// group the open edges by the bone they sit on, which is how a hole is described
const byBone = new Map();
for (const e of open) for (const b of e.bones) {
  const g = byBone.get(b) ?? { n: 0, lo: [...e.at], hi: [...e.at] };
  g.n++;
  for (let k = 0; k < 3; k++) { g.lo[k] = Math.min(g.lo[k], e.at[k]); g.hi[k] = Math.max(g.hi[k], e.at[k]); }
  byBone.set(b, g);
}
for (const [b, g] of [...byBone.entries()].sort((x, y) => y[1].n - x[1].n)) {
  const size = [0, 1, 2].map((k) => (g.hi[k] - g.lo[k]).toFixed(1)).join(" x ");
  console.log(`   ${String(g.n).padStart(4)} open edge(s)  ${(names[b] ?? b).padEnd(32)} spanning ${size}`);
}
