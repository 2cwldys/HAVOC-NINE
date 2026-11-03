import { K, POSE } from "./lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const m = readFileSync("../export-mdl/ins_medic_belt/ins_medic_belt.mdl");
const img = K.lineup([["front", m], ["front-right", m], ["right", m]],
  { ...POSE, yaws: [0, 320, 290], zoom: 2.2, width: 300, cols: 3 });
writeFileSync("out/belt_look.png", K.png(img.width, img.height, img.rgba));
console.log("out/belt_look.png");
