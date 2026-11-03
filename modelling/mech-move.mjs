// Scratch: does anything in the 171 sequences move one bone relative to the
// next? Gear spanning two bones only survives if they stay rigid together.
import { K, load } from "./lib.mjs";

const m = load("ed209_ts");
const names = K.bones(m).map((b) => b.name);
const idx = (n) => names.indexOf(n);
const seqs = K.sequences(m);
console.log(`sequences: ${seqs.length}`);
console.log("first:", JSON.stringify({ ...seqs[0], offset: undefined }).slice(0, 300));

const pairs = [
  ["Bip01 DX Clavicola", "Bip01 DX Braccio superiore"],
  ["Bip01 DX Braccio superiore", "Bip01 DX Avambraccio"],
  ["Bip01 DX Avambraccio", "Bip01 DX Mano"],
  ["Bip01 SX Braccio superiore", "Bip01 SX Avambraccio"],
  ["Bip01 Bacino", "Bip01 Dorso3"],
  ["Bip01 Dorso", "Bip01 Dorso3"],
  ["Bip01 Dorso2", "Bip01 Dorso3"],
  ["Bip01 Dorso3", "Bip01 Testa"],
  ["Bip01 Bacino", "Bip01 DX Coscia"],
];
for (const [a, b] of pairs) if (idx(a) < 0 || idx(b) < 0) console.log(`MISSING ${a} / ${b}`);

const rot = (M) => [0, 1, 2].map((i) => [M[i][0], M[i][1], M[i][2]]);
const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const tr = (R) => R[0][0] + R[1][1] + R[2][2];
const ang = (R) => (Math.acos(Math.min(1, Math.max(-1, (tr(R) - 1) / 2))) * 180) / Math.PI;

for (const [a, b] of pairs) {
  const name = `${a.replace("Bip01 ", "")} -> ${b.replace("Bip01 ", "")}`;
  let ref = null;
  let worst = 0, worstAt = "";
  const bySeq = [];
  for (let s = 0; s < seqs.length; s++) {
    const nf = typeof seqs[s].frames === "number" ? seqs[s].frames : (seqs[s].frames?.length ?? 1);
    let local = 0;
    for (let f = 0; f < nf; f += Math.max(1, Math.floor(nf / 4))) {
      const P = K.poseAt(m, s, f);
      const relm = (() => {
        const Rb = rot(P[idx(b)]);
        const Ra = rot(P[idx(a)]);
        // rel = Rb^T * Ra
        const RbT = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Rb[j][i]));
        return mul(RbT, Ra);
      })();
      if (!ref) ref = relm;
      const d = ang(mul([0, 1, 2].map((i) => [0, 1, 2].map((j) => ref[j][i])), relm));
      if (d > local) local = d;
      if (d > worst) { worst = d; worstAt = `seq ${s} "${seqs[s].name ?? "?"}" frame ${f}`; }
    }
    if (local > 3) bySeq.push(`${s}${seqs[s].name ? ` "${seqs[s].name}"` : ""}: ${local.toFixed(0)}`);
  }
  console.log(`\n${name}: worst ${worst.toFixed(1)} deg  (${worstAt || "none"})`);
  console.log(`  seqs over 3 deg: ${bySeq.length ? bySeq.slice(0, 14).join(", ") + (bySeq.length > 14 ? " ..." : "") : "none"}`);
}
