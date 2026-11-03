// A close look at the belt, because at full figure it is forty pixels tall.
//
//     node belt-closeup.mjs      -> ../export-mdl/belt_closeup.png
//
// Eight yaws round the waist, so every tool is seen square on at least once, and the
// seam where the strap meets the medic bag is seen from both sides.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { K, POSE } from "./lib.mjs";

const OUT = join(process.cwd(), "..", "export-mdl");
const mdl = readFileSync(join(OUT, "ins_medic_belt", "ins_medic_belt.mdl"));

const shots = [], names = [];
for (const yaw of [0, 45, 90, 135, 180, 225, 270, 315]) {
  shots.push(K.render(mdl, { ...POSE, yaw, pitch: 8, zoom: 5.4, target: [0, 0, 3.0], width: 280, height: 300 }));
  names.push(`yaw ${yaw}`);
}
const img = K.tile(shots, 4, names);
writeFileSync(join(OUT, "belt_closeup.png"), K.png(img.width, img.height, img.rgba));
console.log("  wrote export-mdl/belt_closeup.png");
