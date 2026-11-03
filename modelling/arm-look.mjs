// A close look at the left upper arm, from four sides.
import { writeFileSync, readFileSync } from "node:fs";
import { K, IN } from "./lib.mjs";
import { join } from "node:path";

const name = process.argv[2] ?? "repuheavy_fem";
const mdl = readFileSync(join(IN, name, `${name}.mdl`));
const P = K.poseAt(mdl, 1, 0);
const names = K.bones(mdl).map((b) => b.name);
// the left upper arm bone, and where it is
const bi = names.indexOf("Bip01 SX Braccio superiore");
const at = [P[bi][0][3], P[bi][1][3], P[bi][2][3]];
console.log(`  ${name}: left upper arm bone ${bi} at ${at.map((v) => v.toFixed(1)).join(" ")}`);

const shots = [0, 90, 180, 270].map((yaw) => ({ yaw, pitch: 0 }));
const parts = shots.map(({ yaw, pitch }) =>
  K.render(mdl, { seq: 1, frame: 0, yaw, pitch, width: 320, height: 320, at, zoom: 9 }),
);
const W = 320 * parts.length, H = 320;
const rgba = Buffer.alloc(W * H * 4, 255);
parts.forEach((p, i) => {
  for (let y = 0; y < 320; y++)
    Buffer.from(p.rgba).copy(rgba, (y * W + i * 320) * 4, y * 320 * 4, (y * 320 + 320) * 4);
});
const out = join(process.cwd(), "..", "export-mdl", `${name}_leftarm.png`);
writeFileSync(out, K.png(W, H, rgba));
console.log(`  ${out}`);
