import { M } from "../lib.mjs";
console.log("csgFaults", typeof M.csgFaults);
const BOWL = [
  [-1920, -900], [-1860, -1500], [-1400, -1710], [-700, -1760], [0, -1700],
  [700, -1760], [1400, -1710], [1860, -1500], [1920, -900], [1880, -200],
  [1940, 500], [1880, 1100], [1700, 1560], [1100, 1720], [300, 1680],
  [-400, 1740], [-1100, 1700], [-1700, 1540], [-1880, 1000], [-1940, 300],
];
const RIM = 420;
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
let faults = 0, total = 0;
for (let i = 0; i < BOWL.length; i++) {
  const [ax, ay] = BOWL[i];
  const [bx, by] = BOWL[(i + 1) % BOWL.length];
  const length = Math.hypot(bx - ax, by - ay);
  if (length < 300) continue;
  const ux = (bx - ax) / length, uy = (by - ay) / length;
  const from = [ax + ux * length * 0.06, ay + uy * length * 0.06];
  const to = [ax + ux * length * 0.94, ay + uy * length * 0.94];
  const brushes = M.cliffWall({ from, to, bottom: -24, top: RIM - 90 - (i % 3) * 24, rise: 120, foot: 120, seed: i + 1, texture: "canyon_bryce2", clear: CLEAR });
  for (const b of brushes) {
    total++;
    const f = M.csgFaults(b);
    if (f.open.length || f.outside.length) { faults++; console.log("edge", i, "brush", brushes.indexOf(b), f.open[0] ?? f.outside[0]); }
  }
}
console.log({ total, faults });
