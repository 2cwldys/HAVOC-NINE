// node v2-donor.mjs <v_m4.mdl|...> : bones, bodyparts, meshes and sequences of a donor model
import { readFileSync } from "node:fs";
import { readMdl, sequences, posed, restPose } from "file:///D:/Downloads/TSM/smak/src/index.mjs";

const path = process.argv[2];
const src = readFileSync(path);
const info = readMdl(src);
console.log("bones:", info.bones.length);
const { pose } = posed(src, { seq: 0, frame: 0 });
info.bones.forEach((b, i) => {
  const m = pose[i];
  console.log(`  ${String(i).padStart(2)} ${b.padEnd(24)} pos ${m[0][3].toFixed(2)} ${m[1][3].toFixed(2)} ${m[2][3].toFixed(2)}`);
});
console.log("bodyparts:");
info.bodyparts.forEach((bp, i) => {
  console.log(`  [${i}] ${bp.name} models ${bp.models.length}`);
  bp.models.forEach((model, j) => {
    const parts = model.meshes.filter((m) => m.numtris).map((m) => `${m.texture.name}:${m.numtris}`);
    console.log(`     model ${j} ${model.name ?? ""} verts ${model.numverts ?? "?"} meshes ${parts.join(" ") || "(empty)"}`);
  });
});
console.log("textures:", (info.textures ?? []).map((t) => `${t.name} ${t.width}x${t.height}`).join(", "));
const seqs = sequences(src);
console.log("sequences:", seqs.length);
seqs.forEach((s, i) => console.log(`  ${String(i).padStart(2)} ${String(s.name).padEnd(28)} frames ${s.numframes} fps ${s.fps}`));
