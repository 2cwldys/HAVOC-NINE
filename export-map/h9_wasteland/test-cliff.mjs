import { readFileSync } from "node:fs";
import { M } from "../lib.mjs";
const src = readFileSync("wasteland.mjs", "utf8");
// pull the CLEAR literal out by evaluating the module is hard; copy the list here from the file manually
const CLEAR = [
  { min: [-580, 920], max: [580, 1620] }, { min: [-580, -1620], max: [580, -920] },
  { min: [-390, -410], max: [390, 510] }, { min: [-1410, -430], max: [-590, 490] },
  { min: [590, -430], max: [1410, 490] }, { min: [-700, 430], max: [-350, 780] },
  { min: [350, 430], max: [700, 780] }, { min: [-730, -930], max: [-380, -590] },
  { min: [380, -930], max: [730, -590] }, { min: [-930, 780], max: [-690, 1020] },
  { min: [690, -1020], max: [930, -780] }, { min: [-230, 530], max: [230, 990] },
  { min: [-230, -990], max: [230, -530] }, { min: [-1380, -1080], max: [-1120, -820] },
  { min: [1360, 1110], max: [1540, 1290] }, { min: [1040, -1230], max: [1620, -1010] },
  { min: [-780, 200], max: [-700, 360] }, { min: [700, -500], max: [820, -340] },
  { min: [-440, -980], max: [-280, -820] }, { min: [920, 620], max: [1080, 780] },
];
const brushes = M.cliffWall({ from: [-1358, -1713], to: [-742, -1756], bottom: -24, top: 330, rise: 120, foot: 120, seed: 4, texture: "canyon_wall", clear: CLEAR });
console.log("brushes", brushes.length);
const map = { worldspawn: { wad: [] }, brushes, entities: [] };
const plan = M.checkPlan(map, { textures: [] });
for (const e of plan.errors) console.log(e);
